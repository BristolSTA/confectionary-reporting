ARG VARIANT=18
FROM mcr.microsoft.com/vscode/devcontainers/typescript-node:${VARIANT}

COPY ./ .
RUN yarn --no-dev --frozen-lockfile
RUN yarn build
EXPOSE 3000
CMD yarn start
