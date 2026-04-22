    let textoTemporal = "";
    const debounceMs = 2000; // tiempo de debounce <delay> por defecto (ms)

    // Estimador simple de tokens en cliente (heurístico que funciona razonablemente bien)
    function estimateTokens(text) {
        if (!text) return 0;
        try {
            // separar en palabras/unidades unicode o caracteres no espaciales
            const parts = text.match(/[\p{L}\p{N}]+|[^\s\p{L}\p{N}]/gu);
            return parts ? parts.length : 0;
        } catch (e) {
            // fallback simple
            return text.split(/\s+/).filter(Boolean).length;
        }
    }

    // Llamada al servidor Python local para conteo preciso
    async function fetchTokenCount(text) {
        try {
            console.log('iandes: enviando texto al servidor local para conteo...');
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 3000);
            let resp;
            try {
                resp = await fetch('http://127.0.0.1:5000/count', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ text }),
                    signal: controller.signal
                });
            } catch (fetchErr) {
                clearTimeout(timeoutId);
                console.error('iandes: error fetch hacia servidor local:', fetchErr);
                try { window.__iandes_lastFetchError = String(fetchErr); } catch (e) {}
                return null;
            }
            clearTimeout(timeoutId);
            if (!resp.ok) {
                console.error('iandes: servidor local respondió con status', resp.status);
                return null;
            }
            const data = await resp.json().catch((e) => { console.error('iandes: error parseando JSON:', e); return null; });
            return data && (data.tokens ?? null);
        } catch (e) {
            console.error('iandes: excepción en fetchTokenCount:', e);
            try { window.__iandes_lastFetchError = String(e); } catch (ee) {}
            return null;
        }
    }

    function getChatInputs() {
        return Array.from(document.querySelectorAll(
            'textarea, div[contenteditable="true"][role="textbox"], div[contenteditable="true"]'
        ));
    }

    function attachListener(el) {
        if (!el) return false;
        if (el.__iandes_attached) return true;
        el.__iandes_attached = true;
        function saveValue() {
            const value = (el.value !== undefined) ? el.value : (el.innerText || el.textContent || '');
            textoTemporal = value;
                try { 
                    console.log('prompt guardado:', textoTemporal);
                    // estimar tokens localmente para respuesta rápida
                    const estimated = estimateTokens(textoTemporal);
                    console.log('tokens estimados (heurístico):', estimated);
                    try { window.__iandes_lastTokenCount = estimated; window.iandes_getTokenCount = () => window.__iandes_lastTokenCount; } catch(e) {}

                    // Intentar solicitar conteo preciso al servidor Python local
                    (async () => {
                        try {
                            const pythonCount = await fetchTokenCount(textoTemporal);
                            if (pythonCount !== null && pythonCount !== undefined) {
                                console.log('tokens (python):', pythonCount);
                                try { window.__iandes_lastTokenCount = pythonCount; } catch(e) {}
                            }
                        } catch (e) {
                            // no bloquear por error
                        }
                    })();
                } catch (e) {}
        }

        function scheduleDebounce(ms = debounceMs) {
            if (el.__iandes_timer) clearTimeout(el.__iandes_timer);
            el.__iandes_timer = setTimeout(saveValue, ms);
        }

        el.addEventListener('input', () => scheduleDebounce());

        // Pegar / cortar / soltar pueden no actualizar inmediatamente el DOM,
        // así que esperamos un pequeño delay antes de programar el guardado.
        el.addEventListener('paste', () => setTimeout(() => scheduleDebounce(), 50));
        el.addEventListener('cut', () => setTimeout(() => scheduleDebounce(), 50));
        el.addEventListener('drop', () => setTimeout(() => scheduleDebounce(), 50));

        // Capturar borrados y atajos (Backspace/Delete después de Ctrl+A)
        el.addEventListener('keyup', (e) => {
            if (e.key === 'Backspace' || e.key === 'Delete') {
                // guardar rápido tras borrar
                scheduleDebounce(50);
            }
        });

        // Guardar inmediatamente al perder foco
        el.addEventListener('blur', () => saveValue());
        return true;
    }

    // Intento inicial: adjuntar a cualquier input ya presente
    const initialEls = getChatInputs();
    if (initialEls.length) {
        initialEls.forEach(attachListener);
        console.log('Listeners adjuntados a elementos existentes:', initialEls.length);
    } else {
        console.log('No se encontraron inputs inicialmente. Observando DOM...');
    }

    // Observador persistente: procesar solo nodos añadidos para evitar scans completos
    const selector = 'textarea, div[contenteditable="true"][role="textbox"], div[contenteditable="true"]';
    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.type !== 'childList') continue;
            m.addedNodes.forEach(node => {
                if (!node || node.nodeType !== 1) return;
                try {
                    if (node.matches && node.matches(selector)) attachListener(node);
                    const found = node.querySelectorAll ? node.querySelectorAll(selector) : [];
                    Array.from(found).forEach(attachListener);
                } catch (e) {
                    // algunos nodos pueden lanzar en matches/querySelectorAll en ciertos frames
                }
            });
        }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // no se debe retornar solamente los tokens, ademas se debe retornar una medida de agua gastada y co2 estimada, para eso se debe modificar el servidor local en python para que retorne esa informacion adicionalmente al conteo de tokens. 
    // ademas, se debe mejorar el contador de tokens, y el servidor
    // por otro lado se debe agregar lo descrito en el .md