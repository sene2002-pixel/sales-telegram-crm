# Docker public assets

Requirement: include public assets in the Docker build so Vite can resolve the Pico avatar and bundle the Manrope font.

Acceptance: the app image builds successfully and dist/web contains the avatar and font.

Change: copy public into the build stage before npm run build. Vite copies public files into dist/web, which is already included in the runtime image.

Review: no API, permissions, database, or runtime configuration changes. Existing .dockerignore permits public assets.

Validation: docker compose build app passed, including server TypeScript, web TypeScript, and Vite. git diff --check passed. Full npm run check was not run: local npm is unavailable on PATH. Containers serving the application were not restarted.

Rollback: remove COPY public ./public from Dockerfile.
