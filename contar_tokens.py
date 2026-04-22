#sistema contar tokens
import re
import sys
from pathlib import Path

try:
    import tiktoken
except Exception as e:
    raise SystemExit("Instala tiktoken: pip install tiktoken") from e

def extract_text_from_js(path):
    txt = Path(path).read_text(encoding="utf-8")
    # busca todas las asignaciones a textoTemporal y devuelve la última no vacía
    matches = re.findall(r"let\s+textoTemporal\s*=\s*(?P<q>[\"'`])(?P<t>.*?)(?P=q);", txt, re.S)
    if not matches:
        return None
    # matches es una lista de tuplas; el grupo "t" es el segundo elemento
    for q, t in reversed(matches):
        if t and t.strip():
            return t
    # si sólo hay asignaciones vacías, devolver la última (vacía)
    return matches[-1][1]

if __name__ == "__main__":
    js_path = Path("content.js")
    if not js_path.exists():
        print("No se encontró content.js en el directorio actual.")
        sys.exit(1)

    texto = extract_text_from_js(js_path)
    if texto is None or (isinstance(texto, str) and not texto.strip()):
        # si no hay asignación estática o está vacía, pide el texto al usuario
        texto = input("No se pudo extraer `textoTemporal` válido del archivo. Introduce el texto a tokenizar:\n")

    enc = tiktoken.encoding_for_model("gpt-4o")
    tokens = enc.encode(texto)
    print("Número de tokens:", len(tokens))