export const repositorySeedFiles = {
  "tracked.txt": "initial\n",
  "AGENTS.md": "existing repo agents\n",
};

export const windowsEnvironmentProbe = {
  USERPROFILE: "C:\\Users\\cogwork",
  HOMEDRIVE: "C:",
  HOMEPATH: "\\Users\\cogwork",
  APPDATA: "C:\\Users\\cogwork\\AppData\\Roaming",
  SYSTEMROOT: "C:\\Windows",
  PATHEXT: ".COM;.EXE;.BAT;.CMD",
  COMSPEC: "C:\\Windows\\System32\\cmd.exe",
};

export const networkEnvironmentProbe = {
  HTTP_PROXY: "http://proxy.example.test:8080",
  HTTPS_PROXY: "https://proxy.example.test:8443",
  NO_PROXY: "localhost,.example.test",
  http_proxy: "http://lowercase-proxy.example.test:8080",
  https_proxy: "https://lowercase-proxy.example.test:8443",
  NODE_EXTRA_CA_CERTS: "/tmp/cogwork-enterprise-ca.pem",
};
