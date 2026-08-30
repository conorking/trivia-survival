# Trivia Survival — production image
# Plain Node + Express + Socket.io, no build step. Static files are served
# straight out of public/ by server.js (express.static), so nothing needs
# bundling — this just installs deps and copies the two directories the
# server actually reads at runtime (server/ and public/).

FROM node:22-alpine
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server ./server
COPY public ./public

# server.js reads PORT from the environment (defaults to 3000 if unset) —
# see server/server.js: `const PORT = process.env.PORT || 3000;`
ENV PORT=3000
EXPOSE 3000

# Never run as root - node:22-alpine already ships an unprivileged `node` user,
# so this is free. Matches the same principle the systemd deploy path uses
# (see deploy/trivia-survival.service).
USER node

# Lets `docker ps` / `docker compose ps` / Watchtower report real up-vs-wedged
# status instead of just "process is running". Hits the landing page over
# plain HTTP on the container's own port - no extra endpoint needed.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://localhost:${PORT}/" || exit 1

CMD ["node", "server/server.js"]
