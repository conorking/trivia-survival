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

CMD ["node", "server/server.js"]
