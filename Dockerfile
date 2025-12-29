# Usa un'immagine Node.js leggera
FROM node:20-alpine

# Installa vim
RUN apk add --no-cache vim

# Crea la cartella di lavoro
WORKDIR /app

# Copia i file di configurazione delle dipendenze
COPY package*.json ./

# Installa le dipendenze
RUN npm install

# Copia tutto il resto del progetto
COPY . .

# Compila gli Smart Contract (Genera la cartella artifacts)
RUN npx hardhat compile

# Comando di avvio del bot
CMD ["node", "scripts/runBot.js"]
