import path from "node:path";

const envFilePath = path.join("/home/example", ".cogwork", ".env");

process.loadEnvFile(envFilePath);
