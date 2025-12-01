# Usa uma imagem leve do Node.js
FROM node:18-alpine

# Define o diretório de trabalho dentro do container
WORKDIR /app

# Copia os arquivos de dependência
COPY package*.json ./

# Instala as dependências
RUN npm install --production

# Copia o restante do código
COPY . .

# Expõe a porta 3000 para o Coolify
EXPOSE 3000

# Comando para iniciar o servidor
CMD ["npm", "start"]
