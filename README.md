# ⚽ La Polla Mundialista 30X

Landing de predicciones del Mundial 2026, estilo 30X × Colombia.

- Muestra **los partidos de HOY** (hora Colombia) vía la API pública de ESPN, con calendario de respaldo embebido.
- Cada partido **se cierra automáticamente cuando empieza** (hora de inicio o estado en vivo de la API). En vivo muestra marcador y reloj.
- Captura **nombre, correo y celular** (+57, validado) con autorización de datos (Ley 1581).
- Predicciones se guardan en `localStorage` y se envían a un **webhook configurable**.

## Correr local

Es 100% estático — abre `index.html` en el navegador, o:

```bash
npx serve .
```

## Conectar el webhook (leads)

En [app.js](app.js), línea ~16:

```js
WEBHOOK_URL: "https://tu-n8n.com/webhook/polla-mundialista",
```

Recibe un POST JSON:

```json
{
  "source": "polla-mundialista-30x",
  "fecha": "2026-06-11T17:00:00.000Z",
  "nombre": "Mateo Pirela",
  "correo": "mateo@ejemplo.com",
  "celular": "+573001234567",
  "autorizaDatos": true,
  "diaDePartidos": "2026-06-11",
  "predicciones": [
    { "partidoId": "740312", "partido": "México vs Sudáfrica", "local": 2, "visitante": 1, "marcador": "2-1", "inicio": "2026-06-11T19:00:00Z" }
  ]
}
```

Funciona con n8n (Webhook node → Data Table/Sheets), Make, Zapier o Google Apps Script. Si el envío falla, la polla queda en una cola local (`polla30x_pending`) y se reintenta en la próxima visita.

## Desplegar

Arrastra la carpeta a Netlify / Vercel / Cloudflare Pages. Sin build, sin dependencias.

## Notas

- El puntaje (exacto = 3 pts, ganador = 1 pt) se calcula fuera de la landing (en tu n8n/Sheets) con los resultados finales.
- Los textos de premios/ranking son editables en [index.html](index.html).
- Banderas servidas desde el CDN de ESPN; si fallan, se muestra la sigla del país.
