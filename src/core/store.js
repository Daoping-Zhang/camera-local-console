import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "config.json");

const defaultState = {
  server: {
    baseUrl: "http://localhost:18091",
    loginPath: "/user/login",
    cameraDataPath: "/contact/sync/cameraData",
    legacyHikBaseUrl: "",
    tokenHeader: "Authorization",
    token: "",
    localDebug: false
  },
  localCollector: {
    baseUrl: "http://127.0.0.1:3100",
    autoConnect: true
  },
  cameraDefaults: {
    username: "admin",
    sdkPort: 8000,
    savePassword: false
  },
  shop: {
    shopId: "",
    shopName: ""
  },
  release: {
    version: "0.1.0",
    channel: "stable",
    manifestUrl: "http://www.fenqunshuju.com/releases/camera-local-console/channels/stable.json",
    lastCheckAt: "",
    lastCheckResult: null
  },
  devices: []
};

export function loadState() {
  try {
    if (!fs.existsSync(STORE_PATH)) {
      return structuredClone(defaultState);
    }
    const parsed = JSON.parse(fs.readFileSync(STORE_PATH, "utf8"));
    return merge(defaultState, parsed);
  } catch {
    return structuredClone(defaultState);
  }
}

export function saveState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(state, null, 2));
}

function merge(base, override) {
  const output = structuredClone(base);
  for (const [key, value] of Object.entries(override || {})) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      output[key] = merge(output[key] || {}, value);
    } else {
      output[key] = value;
    }
  }
  return output;
}
