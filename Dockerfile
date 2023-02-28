ARG VARIANT=18
FROM mcr.microsoft.com/vscode/devcontainers/typescript-node:${VARIANT}

RUN yarn build
EXPOSE 3000
CMD yarn start
