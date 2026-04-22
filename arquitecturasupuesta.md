> **Versión:** 1.0 · **Estado:** Diseño aprobado · **Paradigma:** Progressive Enhancement

---

## Contexto y filosofía del proyecto

El Agente 3 es el **módulo optimizador de una extensión de navegador cuyo objetivo es reducir la huella hídrica y de carbono generada por el uso de LLMs.** Su función principal es comprimir el prompt del usuario antes de enviarlo al modelo, reduciendo el número de tokens consumidos y, por tanto, el cómputo necesario en los servidores del proveedor.

**Principio rector:** Todo el procesamiento debe ocurrir localmente, en el dispositivo del usuario, sin enviar datos a infraestructura externa durante la operación.

**Patrón de diseño central:** Progressive Enhancement — la extensión funciona en cualquier computadora en su forma básica, y escala en calidad según las capacidades del hardware y software del usuario.

---

## Registro de decisiones arquitectónicas (ADR)

### ❌ Descartado: Motor LLM nativo (Ollama instalado por la extensión)

**Problema:** La instalación de binarios nativos en Windows genera falsos positivos en Windows Defender, corrompiendo la instalación o bloqueando el ejecutable. Inaceptable para el usuario final.

### ❌ Descartado: Inferencia in-browser con WebGPU / WebLLM

**Problema:** Cargar un modelo de varios GB en la caché del navegador satura la RAM del sistema. Chrome ya consume recursos considerables; añadir un modelo generativo colapsa la experiencia de usuario en hardware modesto.

### ❌ Descartado: API de IA en la nube (OpenAI, Groq, Hugging Face)

**Problema:** Contradice el objetivo central del proyecto. Enviar el prompt a un servidor externo para optimizarlo enciende infraestructura remota, consumiendo agua y energía adicionales — anulando el ahorro que se busca generar.

### ✅ Seleccionado: Arquitectura híbrida de compresión en capas

**Fundamento:** Ninguna tecnología única resuelve los tres constraints simultáneamente. La solución es descomponer la tarea en operaciones de complejidad creciente, cada una con su propia tecnología, y activar únicamente las capas que el dispositivo puede ejecutar sin degradar la experiencia.

---

## Arquitectura en capas

```
┌─────────────────────────────────────────────────────────┐
│                    PROMPT DEL USUARIO                   │
└─────────────────────┬───────────────────────────────────┘
                      │
                      |
                      ▼
┌─────────────────────────────────────────────────────────┐
│  CAPA 0 — Router / Clasificador de intención            │
│  JavaScript síncrono · 0 ms · 0 RAM                     │
└─────────────────────┬───────────────────────────────────┘
                      │  Determina qué capas activar
                      ▼
┌─────────────────────────────────────────────────────────┐
│  CAPA 1 — Filtro léxico determinista                    │
│  Regex + reglas posicionales · ~1 ms · 0 RAM            │
└─────────────────────┬───────────────────────────────────┘
                      │  Prompt sin cortesía ni redundancias literales
                      ▼
┌─────────────────────────────────────────────────────────┐
│  CAPA 2 — Deduplicador semántico por embeddings         │
│  ONNX Runtime Web (WASM) · ~50 ms · ~25 MB RAM          │
└─────────────────────┬───────────────────────────────────┘
                      │  Prompt sin oraciones redundantes
                      ▼
┌─────────────────────────────────────────────────────────┐
│  CAPA 3 — Reescritura generativa (oportunista)          │
│  Ollama en localhost:11434 · solo si está disponible    │
└─────────────────────┬───────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────────┐
│               PROMPT OPTIMIZADO                         │
│         Inyectado de vuelta en el campo de texto        │
└─────────────────────────────────────────────────────────┘
```

---

## Especificación técnica por capa

### Capa 0 — Router / Clasificador de intención

**Tecnología:** JavaScript puro, síncrono, en el Content Script.

**Responsabilidad:** Analizar el prompt entrante y determinar el perfil de compresión más adecuado antes de activar el pipeline. No transforma nada — solo toma decisiones de routing.

**Lógica de clasificación:**

| Perfil detectado                                                  | Capas que se activan                        |
| ----------------------------------------------------------------- | ------------------------------------------- |
| Prompt largo con cortesía y relleno                              | Capas 1 → 2 → 3                           |
| Prompt corto pero vago (< 15 palabras, sin información concreta) | Solo Capa 3                                 |
| Prompt largo y técnico sin redundancias aparentes                | Capas 1 → 2                                |
| Prompt ya óptimo (denso, conciso, estructurado)                  | Sin transformación · notificar al usuario |

**Señales que usa el clasificador:**

* Longitud total en palabras
* Ratio de palabras funcionales vs. palabras de contenido
* Presencia de patrones de cortesía en las primeras/últimas 40 palabras
* Presencia de saltos de línea o puntuación (señal para Capa 2)

---

### Capa 1 — Filtro léxico determinista

**Tecnología:** Expresiones regulares y arrays de frases fijas. JavaScript síncrono.

**Responsabilidad:** Eliminar "basura conversacional" — cortesía, ruegos, redundancias literales — sin tocar el contenido semántico del prompt.

**Organización de reglas en tres categorías:**

**Categoría A — Regex estructurales (alta confianza, aplican en cualquier posición)**

Detectan construcciones gramaticales de ruego, no palabras aisladas. Ejemplo:

```
/(quisiera|me gustaría|podría[s]?) (pedirte|solicitarte|preguntarte|que)/i
/(necesito|quiero) que me (ayudes|expliques|digas|cuentes)/i
/de forma (muy )?(detallada|exhaustiva|completa|clara y sencilla)/i
```

**Categoría B — Regex posicionales (solo primeros 60 / últimos 40 caracteres)**

Saludos y despedidas casi siempre están en los extremos. Aplicarlos solo en posición reduce el riesgo de falso positivo.

```
/^(hola|buenos días|buenas tardes|espero que estés bien)[,.]?\\s*/i
/(muchas gracias|gracias de antemano|te lo agradezco)[.!]?\\s*$/i
```

**Categoría C — Lista de frases fijas con normalización Unicode**

Matching después de lowercase + eliminación de tildes. Frases como: `por favor`, `te pido que`, `si no es molestia`, `me harías el favor de`.

**Regla de seguridad:** Un falso negativo (dejar basura) es tolerable. Un falso positivo (eliminar contenido útil) es el único error que importa. Cuando haya duda, no eliminar.

---

### Capa 2 — Deduplicador semántico por embeddings

**Tecnología:** `onnxruntime-web` (WebAssembly) con modelo `all-MiniLM-L6-v2` cuantizado INT8. ~22 MB en disco, ~25 MB en RAM activa durante la inferencia. Se ejecuta en el Service Worker de la extensión (Manifest V3), aislado del proceso renderer del navegador.

**Responsabilidad:** Identificar oraciones semánticamente redundantes (misma información expresada dos veces) y eliminar la de menor riqueza léxica.

**Pipeline interno:**

```
1. Segmentación del texto en fragmentos
2. Generación de embeddings por fragmento
3. Cálculo de similitud coseno entre pares
4. Eliminación de fragmentos con similitud > umbral (default: 0.88)
5. Reconstrucción del texto con los fragmentos supervivientes
```

**Algoritmo de segmentación (jerarquía de separadores):**

```
\\n\\n  →  separador de párrafo (peso mayor)
\\n    →  separador de idea (peso medio)
. ? ! →  separador de oración (peso estándar)
```

**Fallback para texto sin puntuación ni saltos de línea:** Chunking por ventana deslizante — fragmentos de ~80 tokens con 20 tokens de solapamiento. Si un chunk tiene similitud > 0.88 con el chunk anterior, se descarta.

**Limitación conocida:** Este modelo no reescribe — solo selecciona. Si el usuario expresa una idea única en un solo bloque de texto, esta capa no tiene nada que eliminar y pasa el texto sin modificar a la siguiente capa.

---

### Capa 3 — Reescritura generativa (oportunista)

**Tecnología:** Ollama corriendo en `localhost:11434`. La extensión no instala Ollama — lo detecta.

**Responsabilidad:** Reescritura semántica de alta calidad. Esta es la única capa capaz de reformular sin reducir mecánicamente.

**Flujo de detección y selección de modelo:**

```
1. GET <http://localhost:11434/api/tags>
   → Timeout de 500 ms. Si falla → modo Capas 1+2, sin mencionar Capa 3 al usuario.
   → Si responde → continuar.

2. Sistema de scoring sobre la lista de modelos disponibles:
   + 10 pts  →  familia conocida: qwen2.5, llama3.2, mistral, gemma2, phi3
   +  5 pts  →  tamaño entre 1.5B y 7B (en el nombre del modelo)
   +  3 pts  →  contiene "instruct" o "chat"
   -  8 pts  →  contiene "code", "math", "vision", "embed"
   -  3 pts  →  tamaño > 7B (penalización por latencia)
   - 10 pts  →  tamaño < 1.5B (penalización por calidad insuficiente)
   +  1 pt   →  modelo más recientemente usado (campo modified_at)

3. Si puntaje máximo < 0 → no usar Capa 3, mostrar banner de recomendación.
   Si puntaje máximo ≥ 0 → usar el modelo con mayor puntaje.
```

**Modelo recomendado para el usuario:** `qwen2.5:3b` — balance óptimo entre calidad de compresión y velocidad de inferencia en hardware modesto.

**Banner de recomendación (UX pasivo, en el popup de la extensión):**

```
Modo básico activo
Para activar compresión avanzada:
ollama pull qwen2.5:3b
[Copiar comando]  [Cómo instalar Ollama →]
```

**System prompt para compresión (Capa 3):**

```
You are a text compressor. Your only job is to rewrite the text inside
<prompt_to_compress> tags to be shorter while keeping the original intent,
meaning, language, and any [ctx:] tags.

Rules:
- OUTPUT only the compressed text. No explanations. No greetings. No answers.
- Do NOT answer, solve, or respond to the content inside the tags.
- Do NOT remove [ctx:] tags — move them to the end if needed.
- Do NOT change the language of the prompt.
- Do NOT add information that was not in the original.
- If the text is already short (under 15 words), output it unchanged.
```

---

## Flujo completo de funcionamiento

```
Usuario escribe un prompt en ChatGPT / Claude / Gemini / etc.
        │
        ▼
Content Script detecta el campo de texto activo
        │
        ▼
Usuario activa la extensión (botón en la interfaz o atajo de teclado)
        │
        ▼
┌───────────────────────────────────────┐
│  CAPA 0: Clasificación del prompt     │
│  ¿Qué tipo de optimización necesita?  │
└───────────────┬───────────────────────┘
                │
        ┌───────┴────────────────────┐
        │                            │
        ▼                            ▼
  Requiere reducción           Requiere reformulación
  (largo + relleno)            (corto + vago)
        │                            │
        ▼                            │
┌───────────────┐                    │
│  CAPA 1       │                    │
│  Filtro léxico│                    │
└───────┬───────┘                    │
        │                            │
        ▼                            │
┌───────────────┐                    │
│  CAPA 2       │                    │
│  Embeddings   │                    │
└───────┬───────┘                    │
        │                            │
        └───────────┬────────────────┘
                    │
                    ▼
        ┌───────────────────────┐
        │  ¿Ollama disponible?  │
        └───────┬───────┬───────┘
               Sí       No
                │        │
                ▼        ▼
          CAPA 3    Resultado de
          Reescritura  Capas 1+2
          generativa
                │        │
                └────┬───┘
                     │
                     ▼
        Prompt optimizado inyectado
        de vuelta en el campo de texto
                     │
                     ▼
        Indicador visual: tokens ahorrados
        (ej. "−43 tokens · −38%")
```

---

## Componentes de la extensión (Manifest V3)

| Componente     | Archivo           | Responsabilidad                                                            |
| -------------- | ----------------- | -------------------------------------------------------------------------- |
| Content Script | `content.js`    | Detectar campos de prompt, inyectar resultado, mostrar indicador de tokens |
| Service Worker | `background.js` | Orquestar el pipeline, mantener ONNX Runtime, hacer fetch a Ollama         |
| Popup          | `popup.html`    | UI de configuración, estado del sistema, banner de recomendación         |
| Cache API      | Gestionada por SW | Almacenar el modelo `.onnx`tras la primera descarga                      |

---

## Modelo de degradación graceful

| Escenario del usuario                            | Experiencia                                                          |
| ------------------------------------------------ | -------------------------------------------------------------------- |
| Hardware modesto, sin Ollama                     | Capas 0+1+2 activas. Reducción léxica y semántica. Calidad buena. |
| Hardware modesto, con Ollama + modelo adecuado   | Pipeline completo. Calidad óptima.                                  |
| Hardware modesto, con Ollama + modelo inadecuado | Capas 0+1+2 + banner de recomendación.                              |
| Sin conexión a internet                         | Funciona igual — toda la operación es local.                       |
| Primera vez (modelo ONNX no descargado)          | Descarga explícita con barra de progreso (~22 MB). Una sola vez.    |

---

---

# [PLUS] Módulo de Mejora de Prompts con Prompt Engineering

> **Estado:** Diseño opcional · Desarrollo posterior al módulo de compresión

---

## Diferencia fundamental con el módulo de compresión

| Dimensión              | Módulo de compresión                   | Módulo de mejora                      |
| ----------------------- | ---------------------------------------- | -------------------------------------- |
| Dirección              | Reduce (mismo significado, menos tokens) | Expande y reestructura                 |
| Contrato con el usuario | "No añado nada que no escribiste"       | "Mejoro cómo expresas lo que quieres" |
| Modelo mínimo viable   | 1.5B–3B parámetros                     | 3B parámetros mínimo                 |
| Sin Ollama              | Funciona bien (Capas 1+2)                | Degradación notable (solo plantillas) |
| Resultado               | Prompt más corto                        | Prompt más efectivo                   |

**Decisión de integración:** Mismo proyecto, mismo popup, mismos componentes de infraestructura. Diferente modo de operación seleccionado por el usuario antes de procesar.

```
┌─────────────────────────────────────────┐
│  ¿Qué quieres hacer con tu prompt?     │
│                                         │
│  [Comprimir]   [Mejorar]               │
└─────────────────────────────────────────┘
```

---

## Marco teórico: componentes de un prompt bien construido

Un prompt efectivo tiene hasta cinco componentes. El módulo de mejora detecta cuáles están presentes y cuáles faltan, luego los añade o refuerza.

| Componente              | Descripción                                | Ejemplo                                    |
| ----------------------- | ------------------------------------------- | ------------------------------------------ |
| **Rol**           | Quién es el modelo en este contexto        | "Actúa como profesor de secundaria"       |
| **Tarea**         | Qué hacer, con verbo de acción explícito | "Explica la fotosíntesis"                 |
| **Contexto**      | Información de fondo relevante             | "para un alumno de 14 años"               |
| **Restricciones** | Formato, longitud, qué evitar              | "en menos de 200 palabras, sin fórmulas"  |
| **Ejemplo**       | Caso de referencia si aplica                | "como lo harías en clase, con analogías" |

---

## Arquitectura en capas del módulo de mejora

### Capa 0-M — Detector de componentes presentes

**Tecnología:** JavaScript + modelo de embeddings de Capa 2 (reutilizado).

**Responsabilidad:** Antes de mejorar, identificar qué componentes ya existen en el prompt del usuario para no añadir lo que ya está.

**Método de detección:**

Para cada componente, calcular similitud coseno entre el prompt y embeddings de referencia pre-calculados:

* Rol: embeddings de frases como "actúa como", "eres un experto en", "imagina que eres"
* Tarea: detectar verbo de acción en posición dominante (explica, resume, genera, analiza, compara)
* Contexto: detectar información personal o de situación (soy, tengo, estoy preparando, necesito para)
* Restricciones: detectar palabras de límite (máximo, mínimo, sin, solo, en formato, en menos de)
* Ejemplo: detectar marcadores de ilustración (por ejemplo, como si, tipo, similar a)

**Output del detector:** Un objeto de estado con los componentes presentes y ausentes:

```json
{
  "rol": false,
  "tarea": true,
  "contexto": true,
  "restricciones": false,
  "ejemplo": false,
  "score_completitud": 0.4
}
```

Si `score_completitud >= 0.8` → el prompt ya está bien construido → notificar al usuario y no transformar.

---

### Capa 1-M — Mejora por plantillas (sin Ollama)

**Tecnología:** JavaScript + plantillas parametrizadas por tipo de tarea detectada.

**Responsabilidad:** Cuando Ollama no está disponible, ofrecer una mejora estructural básica basada en el perfil del prompt. No es generativa — es estructural.

**Clasificación del tipo de tarea (por palabras clave):**

| Tipo detectado             | Plantilla aplicada                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------- |
| Explicación / aprendizaje | Añade rol de "experto que explica a [nivel inferido]" + restricción de claridad   |
| Corrección de código     | Añade contexto de lenguaje + restricción de explicar el error, no solo corregirlo |
| Resumen                    | Añade restricción de longitud y formato (puntos clave vs. párrafo)               |
| Generación creativa       | Añade restricción de tono y extensión                                            |
| Análisis / comparación   | Añade estructura de criterios explícitos                                          |

**Limitación transparente:** La mejora por plantillas es predecible y a veces genérica. El usuario debe saber que está en modo básico y que Ollama habilitaría mejoras personalizadas.

---

### Capa 2-M — Mejora generativa (con Ollama)

**Tecnología:** Ollama en `localhost:11434`, mismo sistema de detección y scoring que Capa 3 del módulo de compresión.

**Responsabilidad:** Reescritura inteligente del prompt añadiendo los componentes faltantes detectados por Capa 0-M, respetando el idioma, el tono y la intención original del usuario.

**System prompt para mejora (Capa 2-M):**

```
You are a prompt engineering expert. Your job is to improve the prompt inside
<prompt_to_improve> tags by adding missing components to make it more effective.

The analysis shows these components are MISSING: {missing_components}
These components are PRESENT (do NOT modify them): {present_components}

Rules:
- OUTPUT only the improved prompt. No explanations. No preamble.
- PRESERVE the original language of the prompt.
- PRESERVE the original intent — do not change what the user is asking for.
- ADD only the missing components in a natural, integrated way.
- Do NOT make the prompt longer than necessary.
- If the prompt is already complete (all components present), output it unchanged.
```

**Comportamiento esperado — ejemplo:**

```
INPUT:  "explícame la fotosíntesis"

Detector identifica:
  ✅ tarea presente
  ❌ rol ausente
  ❌ contexto ausente
  ❌ restricciones ausentes

OUTPUT: "Actúa como profesor de biología de secundaria.
         Explícame la fotosíntesis de forma clara y sencilla,
         usando analogías si es posible, en un máximo de 150 palabras."
```

---

## Flujo completo del módulo de mejora

```
Usuario selecciona modo "Mejorar" en el popup
        │
        ▼
CAPA 0-M: Detector de componentes
¿Qué tiene el prompt? ¿Qué le falta?
        │
        ├── score_completitud >= 0.8 ──→ "Tu prompt ya está bien construido ✓"
        │                                  (sin transformación)
        │
        └── score_completitud < 0.8
                │
                ▼
        ¿Ollama disponible y modelo adecuado?
                │
        ┌───────┴─────────┐
       No                 Sí
        │                  │
        ▼                  ▼
  CAPA 1-M           CAPA 2-M
  Plantillas         Mejora generativa
  estructurales      personalizada
        │                  │
        └─────┬────────────┘
              │
              ▼
  Prompt mejorado mostrado al usuario
  con diff visual (qué se añadió)
              │
              ▼
  [Aceptar y reemplazar]  [Ver cambios]  [Descartar]
```

---

## UX del diff visual

Antes de reemplazar el prompt en el campo de texto, el usuario ve:

```
┌─────────────────────────────────────────────────────────┐
│  Prompt mejorado                                        │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  [+] Actúa como profesor de biología de secundaria.    │
│  Explícame la fotosíntesis                             │
│  [+] de forma clara y sencilla, usando analogías,      │
│  [+] en un máximo de 150 palabras.                     │
│                                                         │
│  Componentes añadidos: Rol · Restricciones             │
│                                                         │
│  [Aceptar]              [Descartar]                    │
└─────────────────────────────────────────────────────────┘
```

El texto en `[+]` indica lo añadido por el módulo. El texto sin marcador es lo que el usuario escribió originalmente, preservado intacto.

---

## Notas de implementación para el módulo de mejora

* **Orden de desarrollo recomendado:** Implementar y estabilizar el módulo de compresión primero. El módulo de mejora reutiliza el 70% de la infraestructura (Service Worker, ONNX, detección de Ollama).
* **Dependencia crítica de Capa 3:** A diferencia de la compresión, la mejora generativa es cualitativamente superior a las plantillas. Comunicar esta diferencia al usuario es parte del diseño, no una limitación a ocultar.
* **Embeddings de referencia pre-calculados:** Los vectores de referencia para detectar componentes de prompts deben calcularse offline y empaquetarse con la extensión como un archivo JSON (~50 KB). No se recalculan en runtime.
* **Idioma:** El detector de componentes debe ser agnóstico al idioma (trabaja sobre embeddings). El system prompt de mejora preserva el idioma original. No se necesitan reglas por idioma.
