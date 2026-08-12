import argparse
import json
import os
import platform
import sys
import threading
import time
import urllib.request
import xml.etree.ElementTree as ET
from ctypes import *
from pathlib import Path


COMM_ALARM_PDC = 0x1103
COMM_ISAPI_ALARM = 0x6009
NET_SDK_INIT_CFG_SDK_PATH = 2
NET_SDK_INIT_CFG_LIBEAY_PATH = 3
NET_SDK_INIT_CFG_SSLEAY_PATH = 4
NET_DVR_LOCAL_CFG_TYPE_GENERAL = 17


def command_name(command):
    names = {
        COMM_ALARM_PDC: "COMM_ALARM_PDC",
        COMM_ISAPI_ALARM: "COMM_ISAPI_ALARM",
    }
    return names.get(int(command), "UNKNOWN")


def platform_types():
    system = platform.system().lower()
    bits = platform.architecture()[0]
    is_64 = "64" in bits
    if system == "windows":
        return {
            "system": system,
            "load": windll.LoadLibrary,
            "callback": WINFUNCTYPE,
            "long": c_long,
            "dword": c_ulong,
            "llong": c_longlong,
        }
    if system == "linux":
        return {
            "system": system,
            "load": cdll.LoadLibrary,
            "callback": CFUNCTYPE,
            "long": c_int,
            "dword": c_uint,
            "llong": c_long if is_64 else c_long,
        }
    raise RuntimeError(f"unsupported platform: {system}")


PT = platform_types()
C_LONG = PT["long"]
C_DWORD = PT["dword"]
C_BYTE = c_ubyte
C_WORD = c_ushort


class NET_DVR_LOCAL_SDK_PATH(Structure):
    _fields_ = [
        ("sPath", c_char * 256),
        ("byRes", C_BYTE * 128),
    ]


class NET_DVR_LOCAL_GENERAL_CFG(Structure):
    _fields_ = [
        ("byExceptionCbDirectly", C_BYTE),
        ("byNotSplitRecordFile", C_BYTE),
        ("byResumeUpgradeEnable", C_BYTE),
        ("byAlarmJsonPictureSeparate", C_BYTE),
        ("byRes", C_BYTE * 4),
        ("i64FileSize", c_ulonglong),
        ("dwResumeUpgradeTimeout", C_DWORD),
        ("byAlarmReconnectMode", C_BYTE),
        ("byStdXmlBufferSize", C_BYTE),
        ("byMultiplexing", C_BYTE),
        ("byFastUpgrade", C_BYTE),
        ("byRes1", C_BYTE * 232),
    ]


class NET_DVR_DEVICEINFO_V30(Structure):
    _fields_ = [
        ("sSerialNumber", C_BYTE * 48),
        ("byAlarmInPortNum", C_BYTE),
        ("byAlarmOutPortNum", C_BYTE),
        ("byDiskNum", C_BYTE),
        ("byDVRType", C_BYTE),
        ("byChanNum", C_BYTE),
        ("byStartChan", C_BYTE),
        ("byAudioChanNum", C_BYTE),
        ("byIPChanNum", C_BYTE),
        ("byZeroChanNum", C_BYTE),
        ("byMainProto", C_BYTE),
        ("bySubProto", C_BYTE),
        ("bySupport", C_BYTE),
        ("bySupport1", C_BYTE),
        ("bySupport2", C_BYTE),
        ("wDevType", C_WORD),
        ("bySupport3", C_BYTE),
        ("byMultiStreamProto", C_BYTE),
        ("byStartDChan", C_BYTE),
        ("byStartDTalkChan", C_BYTE),
        ("byHighDChanNum", C_BYTE),
        ("bySupport4", C_BYTE),
        ("byLanguageType", C_BYTE),
        ("byVoiceInChanNum", C_BYTE),
        ("byStartVoiceInChanNo", C_BYTE),
        ("bySupport5", C_BYTE),
        ("bySupport6", C_BYTE),
        ("byMirrorChanNum", C_BYTE),
        ("wStartMirrorChanNo", C_WORD),
        ("bySupport7", C_BYTE),
        ("byRes2", C_BYTE),
    ]


class NET_DVR_DEVICEINFO_V40(Structure):
    _fields_ = [
        ("struDeviceV30", NET_DVR_DEVICEINFO_V30),
        ("bySupportLock", C_BYTE),
        ("byRetryLoginTime", C_BYTE),
        ("byPasswordLevel", C_BYTE),
        ("byProxyType", C_BYTE),
        ("dwSurplusLockTime", C_DWORD),
        ("byCharEncodeType", C_BYTE),
        ("bySupportDev5", C_BYTE),
        ("bySupport", C_BYTE),
        ("byLoginMode", C_BYTE),
        ("dwOEMCode", C_DWORD),
        ("iResidualValidity", C_LONG),
        ("byResidualValidity", C_BYTE),
        ("bySingleStartDTalkChan", C_BYTE),
        ("bySingleDTalkChanNums", C_BYTE),
        ("byPassWordResetLevel", C_BYTE),
        ("bySupportStreamEncrypt", C_BYTE),
        ("byMarketType", C_BYTE),
        ("byRes2", C_BYTE * 238),
    ]


LOGIN_CALLBACK = PT["callback"](None, C_LONG, C_DWORD, POINTER(NET_DVR_DEVICEINFO_V30), c_void_p)


class NET_DVR_USER_LOGIN_INFO(Structure):
    _fields_ = [
        ("sDeviceAddress", c_char * 129),
        ("byUseTransport", C_BYTE),
        ("wPort", C_WORD),
        ("sUserName", c_char * 64),
        ("sPassword", c_char * 64),
        ("cbLoginResult", LOGIN_CALLBACK),
        ("pUser", c_void_p),
        ("bUseAsynLogin", C_DWORD),
        ("byProxyType", C_BYTE),
        ("byUseUTCTime", C_BYTE),
        ("byLoginMode", C_BYTE),
        ("byHttps", C_BYTE),
        ("iProxyID", C_DWORD),
        ("byVerifyMode", C_BYTE),
        ("byRes3", C_BYTE * 119),
    ]


class NET_DVR_ALARMER(Structure):
    _fields_ = [
        ("byUserIDValid", C_BYTE),
        ("bySerialValid", C_BYTE),
        ("byVersionValid", C_BYTE),
        ("byDeviceNameValid", C_BYTE),
        ("byMacAddrValid", C_BYTE),
        ("byLinkPortValid", C_BYTE),
        ("byDeviceIPValid", C_BYTE),
        ("bySocketIPValid", C_BYTE),
        ("lUserID", C_LONG),
        ("sSerialNumber", C_BYTE * 48),
        ("dwDeviceVersion", C_DWORD),
        ("sDeviceName", C_BYTE * 32),
        ("byMacAddr", C_BYTE * 6),
        ("wLinkPort", C_WORD),
        ("sDeviceIP", C_BYTE * 128),
        ("sSocketIP", C_BYTE * 128),
        ("byIpProtocol", C_BYTE),
        ("byRes2", C_BYTE * 11),
    ]


class NET_DVR_SETUPALARM_PARAM(Structure):
    _fields_ = [
        ("dwSize", C_DWORD),
        ("byLevel", C_BYTE),
        ("byAlarmInfoType", C_BYTE),
        ("byRetAlarmTypeV40", C_BYTE),
        ("byRetDevInfoVersion", C_BYTE),
        ("byRetVQDAlarmType", C_BYTE),
        ("byFaceAlarmDetection", C_BYTE),
        ("bySupport", C_BYTE),
        ("byBrokenNetHttp", C_BYTE),
        ("wTaskNo", C_WORD),
        ("byDeployType", C_BYTE),
        ("byRes1", C_BYTE * 3),
        ("byAlarmTypeURL", C_BYTE),
        ("byCustomCtrl", C_BYTE),
    ]


class NET_DVR_TIME(Structure):
    _fields_ = [
        ("dwYear", C_DWORD),
        ("dwMonth", C_DWORD),
        ("dwDay", C_DWORD),
        ("dwHour", C_DWORD),
        ("dwMinute", C_DWORD),
        ("dwSecond", C_DWORD),
    ]


class NET_DVR_IPADDR(Structure):
    _fields_ = [
        ("sIpV4", c_char * 16),
        ("sIpV6", C_BYTE * 128),
    ]


class NET_VCA_DEV_INFO(Structure):
    _fields_ = [
        ("struDevIP", NET_DVR_IPADDR),
        ("wPort", C_WORD),
        ("byChannel", C_BYTE),
        ("byIvmsChannel", C_BYTE),
    ]


class NET_DVR_PDC_STAT_FRAME(Structure):
    _fields_ = [
        ("dwRelativeTime", C_DWORD),
        ("dwAbsTime", C_DWORD),
        ("byTimeDiffFlag", C_BYTE),
        ("cTimeDifferenceH", c_char),
        ("cTimeDifferenceM", c_char),
        ("byRes", C_BYTE * 89),
    ]


class NET_DVR_PDC_STAT_TIME(Structure):
    _fields_ = [
        ("tmStart", NET_DVR_TIME),
        ("tmEnd", NET_DVR_TIME),
        ("byTimeDifferenceFlag", C_BYTE),
        ("cStartTimeDifferenceH", c_char),
        ("cStartTimeDifferenceM", c_char),
        ("cStopTimeDifferenceH", c_char),
        ("cStopTimeDifferenceM", c_char),
        ("byRes", C_BYTE * 87),
    ]


class NET_DVR_PDC_STAT_UNION(Union):
    _fields_ = [
        ("struStatFrame", NET_DVR_PDC_STAT_FRAME),
        ("struStatTime", NET_DVR_PDC_STAT_TIME),
    ]


class NET_DVR_PDC_ALRAM_INFO(Structure):
    _fields_ = [
        ("dwSize", C_DWORD),
        ("byMode", C_BYTE),
        ("byChannel", C_BYTE),
        ("bySmart", C_BYTE),
        ("byRes1", C_BYTE),
        ("struDevInfo", NET_VCA_DEV_INFO),
        ("uStatModeParam", NET_DVR_PDC_STAT_UNION),
        ("dwLeaveNum", C_DWORD),
        ("dwEnterNum", C_DWORD),
        ("byBrokenNetHttp", C_BYTE),
        ("byRes3", C_BYTE),
        ("wDevInfoIvmsChannelEx", C_WORD),
        ("dwPassingNum", C_DWORD),
        ("dwChildLeaveNum", C_DWORD),
        ("dwChildEnterNum", C_DWORD),
        ("dwDuplicatePeople", C_DWORD),
        ("dwXmlLen", C_DWORD),
        ("pXmlBuf", c_char_p),
        ("byRes2", C_BYTE * 8),
    ]


class NET_DVR_ALARM_ISAPI_PICDATA(Structure):
    _fields_ = [
        ("dwPicLen", C_DWORD),
        ("byPicType", C_BYTE),
        ("byRes", C_BYTE * 3),
        ("szFilename", c_char * 256),
        ("pPicData", POINTER(C_BYTE)),
    ]


class NET_DVR_ALARM_ISAPI_INFO(Structure):
    _fields_ = [
        ("pAlarmData", c_char_p),
        ("dwAlarmDataLen", C_DWORD),
        ("byDataType", C_BYTE),
        ("byPicturesNumber", C_BYTE),
        ("byRes", C_BYTE * 2),
        ("pPicPackData", c_void_p),
        ("byRes1", C_BYTE * 32),
    ]


MSG_CALLBACK = PT["callback"](c_bool, C_LONG, POINTER(NET_DVR_ALARMER), c_void_p, C_DWORD, c_void_p)


def default_sdk_dir():
    root = Path(__file__).resolve().parents[2]
    if PT["system"] == "windows":
        candidates = [
            root / "camera-local-console" / "vendor" / "hikvision" / "win-x64",
            root / "HCNetSDKV6.1.11.5_build20251204_Win64_ZH" / "库文件",
        ]
    else:
        machine = platform.machine().lower()
        platform_dir = "linux-arm64" if machine in {"aarch64", "arm64"} else "linux-x64"
        candidates = [
            root / "camera-local-console" / "vendor" / "hikvision" / platform_dir,
            Path("/opt/hikvision-sdk"),
            root / "HCNetSDKV6.1.11.5_build20251204_ArmLinux64_ZH" / "MakeAll",
        ]
    for candidate in candidates:
        if candidate.exists():
            return candidate
    return candidates[0]

def encode_path(path):
    encoding = "gbk" if PT["system"] == "windows" else "utf-8"
    return str(path).encode(encoding)


def load_sdk(sdk_dir):
    sdk_dir = Path(sdk_dir).resolve()
    if PT["system"] == "windows":
        os.add_dll_directory(str(sdk_dir))
        com_dir = sdk_dir / "HCNetSDKCom"
        if com_dir.exists():
            os.add_dll_directory(str(com_dir))
        sdk_path = sdk_dir / "HCNetSDK.dll"
    else:
        sdk_path = sdk_dir / "libhcnetsdk.so"
    if not sdk_path.exists():
        raise FileNotFoundError(f"HCNetSDK library not found: {sdk_path}")
    return PT["load"](str(sdk_path)), sdk_dir


def post_json(url, payload, timeout=5):
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        body = response.read().decode("utf-8", errors="replace")
        return json.loads(body) if body else {}


def time_to_text(value):
    if not value.dwYear:
        return time.strftime("%Y-%m-%d %H:%M:%S")
    return f"{value.dwYear:04d}-{value.dwMonth:02d}-{value.dwDay:02d} {value.dwHour:02d}:{value.dwMinute:02d}:{value.dwSecond:02d}"


def bytes_to_text(value):
    raw = bytes(value).split(b"\x00", 1)[0]
    return raw.decode("utf-8", errors="ignore")


def picture_extension(pic_type):
    return {
        1: "jpg",
        2: "wav",
        3: "mp4",
    }.get(int(pic_type), "bin")


def safe_filename(value):
    name = Path(str(value or "").replace("\\", "/")).name.strip()
    if not name:
        return ""
    return "".join(char if char not in '<>:"/\\|?*' and ord(char) >= 32 else "_" for char in name)


def unique_path(path):
    if not path.exists():
        return path
    stem = path.stem
    suffix = path.suffix
    parent = path.parent
    for index in range(1, 10000):
        candidate = parent / f"{stem}-{index}{suffix}"
        if not candidate.exists():
            return candidate
    return parent / f"{stem}-{int(time.time() * 1000)}{suffix}"


def normalize_device_index(value):
    return str(value or "").strip().lower().replace(":", "").replace("-", "")


class HikvisionCollector:
    def __init__(self, args):
        self.args = args
        self.sdk, self.sdk_dir = load_sdk(args.sdk_dir)
        self.user_id = -1
        self.alarm_handle = -1
        self.stop_event = threading.Event()
        self.devices = []
        self.callback = MSG_CALLBACK(self.on_alarm)

    def log(self, level, message, **meta):
        entry = {"time": time.strftime("%Y-%m-%d %H:%M:%S"), "level": level, "message": message, **meta}
        print(json.dumps(entry, ensure_ascii=False), flush=True)

    def init_sdk(self):
        sdk_path_cfg = NET_DVR_LOCAL_SDK_PATH()
        sdk_path_cfg.sPath = encode_path(self.sdk_dir)
        self.sdk.NET_DVR_SetSDKInitCfg(NET_SDK_INIT_CFG_SDK_PATH, byref(sdk_path_cfg))

        crypto = first_existing(self.sdk_dir, ["libcrypto-3-x64.dll", "libcrypto-1_1-x64.dll", "libcrypto.so.3", "libcrypto.so.1.1"])
        ssl = first_existing(self.sdk_dir, ["libssl-3-x64.dll", "libssl-1_1-x64.dll", "libssl.so.3", "libssl.so.1.1"])
        if crypto:
            self.sdk.NET_DVR_SetSDKInitCfg(NET_SDK_INIT_CFG_LIBEAY_PATH, create_string_buffer(encode_path(crypto)))
        if ssl:
            self.sdk.NET_DVR_SetSDKInitCfg(NET_SDK_INIT_CFG_SSLEAY_PATH, create_string_buffer(encode_path(ssl)))

        if not self.sdk.NET_DVR_Init():
            raise RuntimeError(f"NET_DVR_Init failed: {self.last_error()}")

        log_dir = Path(self.args.log_dir).resolve()
        log_dir.mkdir(parents=True, exist_ok=True)
        self.sdk.NET_DVR_SetLogToFile(3, encode_path(log_dir), False)

        general = NET_DVR_LOCAL_GENERAL_CFG()
        general.byAlarmJsonPictureSeparate = 1
        self.sdk.NET_DVR_SetSDKLocalCfg(NET_DVR_LOCAL_CFG_TYPE_GENERAL, byref(general))

        if not self.sdk.NET_DVR_SetDVRMessageCallBack_V31(self.callback, None):
            raise RuntimeError(f"NET_DVR_SetDVRMessageCallBack_V31 failed: {self.last_error()}")

    def login(self):
        login = NET_DVR_USER_LOGIN_INFO()
        login.bUseAsynLogin = 0
        login.sDeviceAddress = self.args.camera_ip.encode("utf-8")
        login.wPort = self.args.camera_port
        login.sUserName = self.args.username.encode("utf-8")
        login.sPassword = self.args.password.encode("utf-8")
        login.byLoginMode = 0
        device_info = NET_DVR_DEVICEINFO_V40()
        self.user_id = self.sdk.NET_DVR_Login_V40(byref(login), byref(device_info))
        if self.user_id < 0:
            raise RuntimeError(f"NET_DVR_Login_V40 failed: {self.last_error()}")
        serial = bytes_to_text(device_info.struDeviceV30.sSerialNumber)
        self.devices = [{
            "deviceKey": self.args.device_key,
            "ipAddress": self.args.camera_ip,
            "macAddress": self.args.mac_address or self.args.device_key,
            "status": "online",
            "serialNumber": serial,
        }]
        self.log("info", "login succeeded", cameraIp=self.args.camera_ip, serialNumber=serial)

    def setup_alarm(self):
        param = NET_DVR_SETUPALARM_PARAM()
        param.dwSize = sizeof(param)
        param.byAlarmInfoType = 1
        param.byDeployType = 1
        self.alarm_handle = self.sdk.NET_DVR_SetupAlarmChan_V41(self.user_id, byref(param))
        if self.alarm_handle < 0:
            raise RuntimeError(f"NET_DVR_SetupAlarmChan_V41 failed: {self.last_error()}")
        self.log("info", "alarm armed", handle=self.alarm_handle)

    def run(self):
        self.init_sdk()
        self.login()
        self.setup_alarm()
        self.send_heartbeat()
        while not self.stop_event.wait(self.args.heartbeat_interval):
            self.send_heartbeat()

    def close(self):
        if self.alarm_handle > -1:
            self.sdk.NET_DVR_CloseAlarmChan_V30(self.alarm_handle)
        if self.user_id > -1:
            self.sdk.NET_DVR_Logout(self.user_id)
        self.sdk.NET_DVR_Cleanup()

    def on_alarm(self, command, alarmer, alarm_info, buf_len, user):
        try:
            if command == COMM_ALARM_PDC:
                pdc = cast(alarm_info, POINTER(NET_DVR_PDC_ALRAM_INFO)).contents
                event = self.pdc_to_event(pdc, alarmer.contents if alarmer else None)
                self.log(
                    "info",
                    "sdk pdc packet",
                    command=hex(command),
                    commandName=command_name(command),
                    bufLen=int(buf_len),
                    channelId=event["channelId"],
                    occurredAt=event["occurredAt"],
                    enter=event["enter"],
                    exit=event["exit"],
                    passing=event["passing"],
                    duplicatePeople=event["duplicatePeople"],
                    raw=event["raw"],
                )
                self.post_event(event)
            elif command == COMM_ISAPI_ALARM:
                isapi = cast(alarm_info, POINTER(NET_DVR_ALARM_ISAPI_INFO)).contents
                events = self.isapi_to_events(isapi, alarmer.contents if alarmer else None, command, buf_len)
                for event in events:
                    self.post_event(event)
            else:
                self.log("info", "sdk alarm packet", command=hex(command), commandName=command_name(command), bufLen=int(buf_len))
        except Exception as exc:
            self.log("error", "alarm callback failed", error=str(exc), command=hex(command))
        return True

    def pdc_to_event(self, pdc, alarmer):
        occurred_at = time.strftime("%Y-%m-%d %H:%M:%S")
        if pdc.byMode in (1, 2):
            occurred_at = time_to_text(pdc.uStatModeParam.struStatTime.tmEnd)
        device_ip = self.args.camera_ip
        if alarmer and alarmer.byDeviceIPValid:
            device_ip = bytes_to_text(alarmer.sDeviceIP) or device_ip
        return {
            "collectorId": self.args.collector_id,
            "source": "hikvision-hcnetsdk",
            "deviceKey": self.args.device_key,
            "macAddress": self.args.mac_address or self.args.device_key,
            "ipAddress": device_ip,
            "channelId": int(pdc.byChannel or self.args.channel_id),
            "eventType": "PeopleCounting",
            "occurredAt": occurred_at,
            "enter": int(pdc.dwEnterNum),
            "exit": int(pdc.dwLeaveNum),
            "passing": int(pdc.dwPassingNum),
            "childEnter": int(pdc.dwChildEnterNum),
            "childExit": int(pdc.dwChildLeaveNum),
            "duplicatePeople": int(pdc.dwDuplicatePeople),
            "raw": {
                "command": hex(COMM_ALARM_PDC),
                "mode": int(pdc.byMode),
                "smart": int(pdc.bySmart),
                "brokenNetHttp": int(pdc.byBrokenNetHttp),
                "xmlLength": int(pdc.dwXmlLen),
            },
        }

    def isapi_to_events(self, isapi, alarmer, command=COMM_ISAPI_ALARM, buf_len=0):
        raw = string_at(isapi.pAlarmData, int(isapi.dwAlarmDataLen)) if isapi.pAlarmData and isapi.dwAlarmDataLen else b""
        text = raw.decode("utf-8", errors="replace").strip()
        packet = {
            "command": hex(command),
            "commandName": command_name(command),
            "bufLen": int(buf_len),
            "dataType": int(isapi.byDataType),
            "pictures": int(isapi.byPicturesNumber),
            "dataLen": int(isapi.dwAlarmDataLen),
        }
        if not text:
            self.log("info", "empty isapi alarm", **packet)
            return []

        log_dir = Path(self.args.log_dir).resolve()
        log_dir.mkdir(parents=True, exist_ok=True)
        capture_id = f"isapi-{int(time.time() * 1000)}"
        capture_path = log_dir / f"{capture_id}.txt"
        capture_path.write_text(text, encoding="utf-8", errors="replace")
        pictures = self.save_isapi_pictures(isapi, log_dir, capture_id)

        parsed = parse_people_counting_isapi(text)
        summary = summarize_isapi(text)
        isapi_data = parse_json_object(text)
        self.log(
            "info",
            "sdk isapi packet",
            **packet,
            **summary,
            sample=text[:1000],
            savedTo=str(capture_path),
            pictureFiles=pictures,
        )
        if summary.get("eventType") == "humanBodyComparison":
            self.post_human_body_event(isapi_data, pictures)
        if not parsed:
            return []

        device_ip = self.args.camera_ip
        if alarmer and alarmer.byDeviceIPValid:
            device_ip = bytes_to_text(alarmer.sDeviceIP) or device_ip
        event = {
            "collectorId": self.args.collector_id,
            "source": "hikvision-isapi-alarm",
            "deviceKey": self.args.device_key,
            "macAddress": self.args.mac_address or self.args.device_key,
            "ipAddress": device_ip,
            "channelId": int(parsed.get("channelId") or self.args.channel_id),
            "eventType": "PeopleCounting",
            "occurredAt": parsed.get("occurredAt") or time.strftime("%Y-%m-%d %H:%M:%S"),
            "enter": int(parsed.get("enter") or 0),
            "exit": int(parsed.get("exit") or 0),
            "passing": int(parsed.get("passing") or 0),
            "duplicatePeople": int(parsed.get("duplicatePeople") or 0),
            "raw": {
                "command": hex(COMM_ISAPI_ALARM),
                "dataType": int(isapi.byDataType),
                "savedTo": str(capture_path),
                "pictureFiles": pictures,
            },
        }
        return [event]

    def save_isapi_pictures(self, isapi, log_dir, capture_id):
        count = int(isapi.byPicturesNumber)
        if count <= 0 or not isapi.pPicPackData:
            return []

        image_dir = log_dir / "images"
        image_dir.mkdir(parents=True, exist_ok=True)
        pic_array = cast(isapi.pPicPackData, POINTER(NET_DVR_ALARM_ISAPI_PICDATA))
        saved = []
        for index in range(count):
            pic = pic_array[index]
            pic_len = int(pic.dwPicLen)
            if pic_len <= 0 or not pic.pPicData:
                saved.append({
                    "index": index,
                    "length": pic_len,
                    "type": int(pic.byPicType),
                    "savedTo": "",
                    "skipped": True,
                })
                continue

            ext = picture_extension(pic.byPicType)
            sdk_name = safe_filename(bytes_to_text(pic.szFilename))
            filename = sdk_name or f"{capture_id}-{index}.{ext}"
            if not Path(filename).suffix:
                filename = f"{filename}.{ext}"
            file_path = unique_path(image_dir / filename)
            data = string_at(pic.pPicData, pic_len)
            file_path.write_bytes(data)
            saved.append({
                "index": index,
                "length": pic_len,
                "type": int(pic.byPicType),
                "filename": filename,
                "savedTo": str(file_path),
            })
        return saved

    def post_event(self, event):
        url = f"{self.args.gateway_url.rstrip('/')}/api/collector/events"
        post_json(url, event)
        self.log("info", "pdc event posted", enter=event["enter"], exit=event["exit"], duplicatePeople=event["duplicatePeople"])

    def post_human_body_event(self, isapi_data, picture_files):
        if not isapi_data:
            return
        url = f"{self.args.gateway_url.rstrip('/')}/api/collector/events"
        event = {
            "collectorId": self.args.collector_id,
            "source": "hikvision-isapi-alarm",
            "deviceKey": self.args.device_key,
            "macAddress": self.args.mac_address or self.args.device_key,
            "ipAddress": isapi_data.get("ipAddress") or self.args.camera_ip,
            "channelId": int(isapi_data.get("channelID") or isapi_data.get("channelId") or self.args.channel_id),
            "eventType": "HumanBodyComparison",
            "occurredAt": normalize_time(isapi_data.get("dateTime") or isapi_data.get("time")) or time.strftime("%Y-%m-%d %H:%M:%S"),
            "raw": {
                "isapi": isapi_data,
                "pictureFiles": picture_files,
            },
        }
        post_json(url, event)
        count = len(isapi_data.get("HumanBodyComparison", [])) if isinstance(isapi_data.get("HumanBodyComparison"), list) else 0
        self.log("info", "human body event posted", count=count, pictures=len(picture_files))

    def send_heartbeat(self):
        url = f"{self.args.gateway_url.rstrip('/')}/api/collector/heartbeat"
        payload = {
            "collectorId": self.args.collector_id,
            "version": "0.1.0",
            "adapter": "hikvision-hcnetsdk",
            "host": platform.node(),
            "devices": self.devices,
        }
        try:
            post_json(url, payload)
            self.log("info", "heartbeat sent", deviceCount=len(self.devices))
        except Exception as exc:
            self.log("warn", "heartbeat failed", error=str(exc))

    def last_error(self):
        try:
            return int(self.sdk.NET_DVR_GetLastError())
        except Exception:
            return -1


def first_existing(base, names):
    for name in names:
        path = Path(base) / name
        if path.exists():
            return path
    return None


def parse_people_counting_isapi(text):
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return None
        return parse_people_counting_dict(data)
    if "<" not in text:
        return None
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return None
    flat = {strip_ns(elem.tag): (elem.text or "").strip() for elem in root.iter()}
    event_type = first_value(flat, ["eventType", "eventDescription", "ruleName"])
    has_counts = any(key in flat for key in ["enter", "enterNum", "enterNumber", "dwEnterNum", "leaveNum", "exit", "exitNum"])
    if event_type and "count" not in event_type.lower() and "pdc" not in event_type.lower() and not has_counts:
        return None
    return {
        "occurredAt": normalize_time(first_value(flat, ["dateTime", "time", "eventTime", "dynChannelID"])),
        "channelId": to_int(first_value(flat, ["channelID", "dynChannelID", "channelId"]), 1),
        "enter": to_int(first_value(flat, ["enter", "enterNum", "enterNumber", "dwEnterNum", "enterCount"]), 0),
        "exit": to_int(first_value(flat, ["exit", "exitNum", "leave", "leaveNum", "leaveNumber", "dwLeaveNum"]), 0),
        "passing": to_int(first_value(flat, ["passing", "passingNum", "peoplePassing", "dwPassingNum"]), 0),
        "duplicatePeople": to_int(first_value(flat, ["duplicatePeople", "duplicatePeopleNum", "dwDuplicatePeople"]), 0),
    } if has_counts else None


def parse_json_object(text):
    if not text or not text.lstrip().startswith("{"):
        return None
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def parse_people_counting_dict(data):
    flat = {}

    def visit(value, prefix=""):
        if isinstance(value, dict):
            for key, item in value.items():
                visit(item, key)
        elif isinstance(value, list):
            for item in value:
                visit(item, prefix)
        else:
            flat[prefix] = value

    visit(data)
    has_counts = any(key in flat for key in ["enter", "enterNum", "enterNumber", "dwEnterNum", "leaveNum", "exit", "exitNum"])
    if not has_counts:
        return None
    return {
        "occurredAt": normalize_time(first_value(flat, ["dateTime", "time", "eventTime"])),
        "channelId": to_int(first_value(flat, ["channelID", "dynChannelID", "channelId"]), 1),
        "enter": to_int(first_value(flat, ["enter", "enterNum", "enterNumber", "dwEnterNum", "enterCount"]), 0),
        "exit": to_int(first_value(flat, ["exit", "exitNum", "leave", "leaveNum", "leaveNumber", "dwLeaveNum"]), 0),
        "passing": to_int(first_value(flat, ["passing", "passingNum", "peoplePassing", "dwPassingNum"]), 0),
        "duplicatePeople": to_int(first_value(flat, ["duplicatePeople", "duplicatePeopleNum", "dwDuplicatePeople"]), 0),
    }


def summarize_isapi(text):
    if text.startswith("{"):
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            return {}
        flat = {}

        def visit(value, prefix=""):
            if isinstance(value, dict):
                for key, item in value.items():
                    visit(item, key)
            elif isinstance(value, list):
                for item in value:
                    visit(item, prefix)
            else:
                flat[prefix] = value

        visit(data)
        return compact_dict({
            "eventType": first_value(flat, ["eventType", "EventType"]),
            "eventDescription": first_value(flat, ["eventDescription", "EventDescription"]),
            "eventState": first_value(flat, ["eventState", "EventState"]),
            "channelId": first_value(flat, ["channelID", "channelId", "ChannelID"]),
            "occurredAt": normalize_time(first_value(flat, ["dateTime", "time", "eventTime"])),
            "ipAddress": first_value(flat, ["ipAddress", "IPAddress"]),
            "macAddress": first_value(flat, ["macAddress", "MACAddress"]),
            "activePostCount": first_value(flat, ["activePostCount"]),
        })

    if "<" not in text:
        return {}
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return {}
    flat = {strip_ns(elem.tag): (elem.text or "").strip() for elem in root.iter()}
    return compact_dict({
        "eventType": first_value(flat, ["eventType", "EventType"]),
        "eventDescription": first_value(flat, ["eventDescription", "EventDescription"]),
        "eventState": first_value(flat, ["eventState", "EventState"]),
        "channelId": first_value(flat, ["channelID", "channelId", "ChannelID"]),
        "occurredAt": normalize_time(first_value(flat, ["dateTime", "time", "eventTime"])),
        "ipAddress": first_value(flat, ["ipAddress", "IPAddress"]),
        "macAddress": first_value(flat, ["macAddress", "MACAddress"]),
        "activePostCount": first_value(flat, ["activePostCount"]),
    })


def compact_dict(data):
    return {key: value for key, value in data.items() if value not in (None, "")}


def strip_ns(tag):
    return tag.rsplit("}", 1)[-1]


def first_value(data, keys):
    for key in keys:
        if key in data and data[key] not in (None, ""):
            return data[key]
    return None


def to_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_time(value):
    if not value:
        return ""
    return str(value).replace("T", " ").split("+", 1)[0].split(".", 1)[0]


def parse_args():
    parser = argparse.ArgumentParser(description="Hikvision HCNetSDK people counting collector")
    parser.add_argument("--sdk-dir", default=os.environ.get("HIK_SDK_DIR", str(default_sdk_dir())))
    parser.add_argument("--gateway-url", default=os.environ.get("GATEWAY_URL", "http://127.0.0.1:3000"))
    parser.add_argument("--collector-id", default=os.environ.get("COLLECTOR_ID", "collector-hikvision-local"))
    parser.add_argument("--camera-ip", default=os.environ.get("CAMERA_IP", ""))
    parser.add_argument("--camera-port", type=int, default=int(os.environ.get("CAMERA_PORT", "8000")))
    parser.add_argument("--username", default=os.environ.get("CAMERA_USERNAME", "admin"))
    parser.add_argument("--password", default=os.environ.get("CAMERA_PASSWORD", ""))
    parser.add_argument("--device-key", default=os.environ.get("DEVICE_KEY", os.environ.get("MAC_ADDRESS", "")))
    parser.add_argument("--mac-address", default=os.environ.get("MAC_ADDRESS", ""))
    parser.add_argument("--channel-id", type=int, default=int(os.environ.get("CHANNEL_ID", "1")))
    parser.add_argument("--heartbeat-interval", type=int, default=int(os.environ.get("HEARTBEAT_INTERVAL_MS", "10000")) // 1000)
    parser.add_argument("--log-dir", default=os.environ.get("HIK_LOG_DIR", "logs/hikvision-sdk"))
    args = parser.parse_args()
    if not args.camera_ip:
        parser.error("--camera-ip or CAMERA_IP is required")
    if not args.device_key:
        args.device_key = args.mac_address or args.camera_ip
    return args


def main():
    collector = HikvisionCollector(parse_args())
    try:
        collector.run()
    except KeyboardInterrupt:
        pass
    except Exception as exc:
        collector.log("error", "collector failed", error=str(exc))
        return 1
    finally:
        collector.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
