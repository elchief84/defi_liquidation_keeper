require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

const ALCHEMY_HTTP_URL = process.env.ALCHEMY_HTTP_URL;
const PRIVATE_KEY = process.env.PRIVATE_KEY;

module.exports = {
  solidity: "0.8.10",
  networks: {
    hardhat: {
      forking: {
        url: ALCHEMY_HTTP_URL,
        enabled: true,
      },
    },
    // Rete locale per i test persistenti
    localhost: {
      url: "http://127.0.0.1:8545",
    },
    // Rete reale (per quando andrai live)
    arbitrum: {
      url: ALCHEMY_HTTP_URL,
      accounts: [PRIVATE_KEY],
    },
  },
};