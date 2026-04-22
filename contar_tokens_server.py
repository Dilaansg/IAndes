from flask import Flask, request, jsonify
import tiktoken

app = Flask(__name__)

@app.after_request
def add_cors(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type'
    response.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
    return response

@app.route('/count', methods=['POST', 'OPTIONS'])
def count_tokens():
    if request.method == 'OPTIONS':
        # responder al preflight con headers CORS
        resp = app.make_response(('', 204))
        resp.headers['Access-Control-Allow-Origin'] = '*'
        resp.headers['Access-Control-Allow-Headers'] = 'Content-Type'
        resp.headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS'
        return resp
    data = request.get_json     (silent=True) or {}
    text = data.get('text', '')
    print('contar_tokens_server: recibida petición, longitud texto:', len(text))
    try:
        enc = tiktoken.encoding_for_model('gpt-4o')
        tokens = enc.encode(text)
        count = len(tokens)
    except Exception:
        # fallback: token count approx by whitespace
        count = len(text.split())
    return jsonify({'tokens': count})

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=5000)
