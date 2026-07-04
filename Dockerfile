# ToolFunnel — zero runtime dependencies, so no install step:
# copy the source, run the CLI. Default mode is the stdio MCP server.
FROM node:20-slim
WORKDIR /app
COPY . .
CMD ["node", "bin/toolfunnel.js"]
