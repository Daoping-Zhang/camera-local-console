import fs from "node:fs";
import path from "node:path";

const DATA_DIR = path.resolve(process.cwd(), "data");
const STORE_PATH = path.join(DATA_DIR, "config.json");

const defaultState = {
  server: {
    // 数据服务地址（统一入口：事件上报 / 门店设备注册 / bootstrap 全部走它）+ 接入令牌
    serverUrl: "https://kequn.fenqunshuju.com:8443",
    siteToken: "",
    localDebug: true
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
    shopId: "10001",
    shopName: "本地调试门店 A"
  },
  console: {
    id: "",
    name: ""
  },
  release: {
    version: "0.1.0",
    channel: "stable",
    manifestUrl: "https://kequn.fenqunshuju.com:8443/releases/camera-local-console/channels/stable.json",
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
