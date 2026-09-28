# MODEOS EL OBI

## Arranque

1. Instala Node.js 20 o superior.
2. Ejecuta `npm install`.
3. Copia `.env.example` a `.env` y completa los valores.
4. En Discord Developer Portal configura como redirect URI:
   `http://localhost:3000/auth/discord/callback`
5. Invita el bot con los permisos e intents necesarios.
6. Ejecuta `npm start` y abre `http://localhost:3000`.

## Servicios incluidos

- OAuth de Discord en `/auth/discord`.
- Sesiones HTTP protegidas.
- Bot real conectado mediante `discord.js`.
- Logs del bot por Server-Sent Events en `/api/discord/logs`.
- Reloj y fecha local visibles en la interfaz.
- Imágenes de portada, Modelos y Directos administrables desde la Zona DEV y persistidas en PostgreSQL.
- Estado global de mantenimiento y avisos públicos persistidos en PostgreSQL, con actualizaciones en vivo por Server-Sent Events.
- Banner de consentimiento con categorías esenciales, analíticas y personalización, preferencias revocables y registro de decisión con marca de tiempo.
- Plantillas legales enlazadas desde el footer: privacidad, términos y política de cookies.
- Página independiente de soporte Discord en `soporte.html`, enlazada desde la tarjeta del Lobby.
- Comandos DEV limitados en `/api/discord/commands`.
- Auditoría DEV en PostgreSQL mediante `/api/dev/security-logs`.
- Bloqueo de contraseña DEV tras cinco intentos fallidos.

No pongas tokens ni secretos dentro de `index.html`. Usa únicamente `.env`.
Las imágenes admitidas son PNG, JPEG y WebP, con un máximo de 2 MB cada una.
Los proveedores opcionales deben registrarse como scripts inertes, por ejemplo `<script type="text/plain" data-consent-category="analytics" data-consent-src="https://proveedor.example/analytics.js"></script>`; `cookies.js` solo los descarga tras consentimiento para su categoría. El Tailwind CDN actual se usa para renderizar la interfaz antes de la elección; la política de cookies lo declara y recomienda alojar localmente Tailwind, fuentes e iconos antes de exigir que no haya solicitudes de terceros previas al consentimiento.
Las páginas legales contienen campos entre corchetes que debe completar y revisar el titular antes de publicarlas. Son plantillas informativas, no asesoramiento ni certificación de cumplimiento.

## Despliegue en Render

1. Crea un Web Service conectado a este repositorio o usa el archivo `render.yaml`.
2. Configura `PUBLIC_URL` con la URL HTTPS del servicio, por ejemplo `https://modeos-el-obi.onrender.com`.
3. Configura `FRONTEND_URL` con la URL pública exacta del frontend, por ejemplo `https://mi-frontend.onrender.com` o `https://usuario.github.io/repositorio`. CORS permite ese origen y rechaza otros para `/api/*`.
4. El JavaScript incluido en `index.html` define `API_URL` y usa por defecto `https://modeos-el-obi.onrender.com`, de acuerdo con el backend declarado en `render.yaml`. Si tu backend usa otro dominio, configúralo en `<meta name="api-base-url" content="https://TU-DOMINIO-BACKEND">` dentro de `index.html`.
5. En el servicio backend de Render, asigna el valor real de `FRONTEND_URL`; `render.yaml` declara la variable, pero Render necesita la URL pública específica del frontend.
6. En Discord Developer Portal añade como redirect URI:
   `https://modeos-el-obi.onrender.com/auth/discord/callback`
7. Completa en Render `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `DISCORD_BOT_TOKEN`, `DEV_PASSWORD` y `DATABASE_URL` como variables secretas.
8. El servicio usa el puerto asignado por Render automáticamente. PostgreSQL se conecta mediante `DATABASE_URL`; no se necesita disco persistente para la base de datos.

Para verificar el despliegue, consulta `https://TU-DOMINIO-BACKEND/api/health`. Debe devolver `status: "ok"`, `database: "connected"` y el commit desplegado en `version`. Si devuelve `404`, Render no está sirviendo el backend actualizado o la URL configurada no corresponde al Web Service.

La aplicación usa PostgreSQL en Neon para conservar los logs y los intentos de acceso al reiniciar o desplegar el servicio.
Al arrancar, el backend crea si faltan las tablas `site_images`, `site_settings` y `site_messages`; no hay que ejecutar un SQL manualmente. El estado público se consulta en `/api/site-state`, y la Zona DEV lo modifica mediante `/api/dev/site-state` y `/api/dev/site-messages`. Las fotos existentes usan `/api/site-images` y `/api/dev/images/:slot`.
