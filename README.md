# JODU52540-Status — 5G Dashboard for OpenWrt LuCI

[![OpenWrt](https://img.shields.io/badge/OpenWrt-21.02%20--%2025.12+-blue?logo=openwrt&logoColor=white)](https://openwrt.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/ODU-Qualcomm%20Snapdragon%20X55%20%2F%20X62%20%2F%20X65-orange)](https://github.com)

A high-performance, real-time **5G NR Telemetry & Control Dashboard** for OpenWrt LuCI web interface.

Built specifically for indoor OpenWrt routers (such as the JioRouter AX6000 JIDU6701, x86_64, MediaTek Filogic, and Qualcomm routers) connected to **Jio AirFiber 5G Outdoor Units (ODU)** and **HFCL 5G CPEs** (*sdxlemur* Qualcomm Snapdragon modems, e.g., JODU52540).

---

## ⚡ 1-Line Quick Install

SSH into your OpenWrt router and run:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/n8anyone/JODU52540-Status/main/install.sh 2>/dev/null || wget -qO- https://raw.githubusercontent.com/n8anyone/JODU52540-Status/main/install.sh)"
```

> **Note:** If your router has `curl` installed, it uses `curl`; otherwise, it automatically falls back to `wget` or `uclient-fetch`.

Once installed:
1. Open your router's LuCI web interface (`http://192.168.1.1` by default).
2. Go to **Status** ➔ **5G Dashboard**.
3. Click the **⚙️ ODU Credentials** button in the header to enter your ODU IP and password.

---

## ✨ Features & Architecture

### 1. 📶 5G NR Telemetry & Carrier Aggregation (CA)
* **Primary Cell (PCC) Metrics:** Live display of Band (n28, n78, etc.), Frequency / ARFCN, Physical Cell ID (PCI), RSRP (dBm), RSRQ (dB), SINR (dB), CQI, Uplink/Downlink Modulation, and Channel Bandwidth.
* **Carrier Aggregation (SCC):** Real-time monitoring of secondary carriers and aggregate carrier metrics.
* **Visual RF Quality Badges:** Instant color-coded signal quality indicators (Excellent / Good / Fair / Poor) based on standard 3GPP thresholds.

### 2. 📡 Neighbor Cell Scanner
* Full visibility of neighboring 5G/4G cell towers with live RSRP/RSRQ readings.
* Enables precise antenna alignment and line-of-sight aiming for your Outdoor Unit.

### 3. 🌡️ 17-Zone Hardware Thermal Telemetry
* Reads live temperatures across all Qualcomm hardware thermal zones directly from `/sys/class/thermal/thermal_zone*` via the low-latency netcat telnet bridge.
* Tracks Power Amplifiers (`modem-lte-sub6-pa1`), CPU cores (`cpuss-0-step`), modem baseband, and mmWave/Sub-6 transceivers.
* Dynamic color coding with warning (>70°C) and critical (>85°C) heat thresholds.

### 4. ⚡ Live Bandwidth Speedometer & Rolling History
* Real-time WAN throughput gauges for instant download and upload speeds (Mbps).
* Interactive rolling graph displaying traffic history and peaks over time.

### 5. 🛠️ Integrated QCMAP & AT Modem Hub Terminal
* Built-in diagnostic console to interact directly with the Qualcomm modem (`sdxlemur`).
* Quick-action buttons for common diagnostics:
  * **IMEI & Device Identity** (`AT+CGSN`)
  * **Firmware Version** (`AT+CGMR`)
  * **Signal Quality** (`AT+CSQ`)
  * **Active Operator & Network** (`AT+COPS?`)
  * **Network Interfaces & Routes** (`ifconfig`, `ip route`)
  * **Connection Tracking** (`nf_conntrack`)
  * **Ping & Latency Test**
  * **Cellular Device Manager & QCMAP Menus**
* Full interactive input field for custom AT commands and shell commands.

### 6. ⏰ Remote ODU Management & Scheduled Reboot
* Instant **One-Click Reboot** trigger for the Outdoor Unit directly from LuCI.
* Automated **Nightly Reboot Scheduler** (configurable time, e.g., 03:00 AM) to maintain optimal latency and prevent carrier connection stale state.

### 7. ⚙️ Secure Credential & Connection Manager
* Zero hardcoded passwords or personal router credentials in the source code.
* Dedicated **ODU Credentials Modal** in LuCI to configure:
  * ODU IP address (default: `192.168.225.1`)
  * ODU Web Admin username (`Admin`) and password
  * Telnet port (`23`), username (`root`), and optional telnet password
* Securely persisted in OpenWrt's native UCI configuration system (`/etc/config/jodu52540`).

### 8. 🎨 Modern Dark-Themed UI
* Clean, responsive design optimized for desktop and mobile displays.
* Slide-out **Control Centre** drawer to customize polling intervals, toggle individual telemetry sections, and adjust visual themes.

---

## 📂 Repository File Structure

```
.
├── install.sh                                      # Automated OpenWrt 1-line installer
├── uninstall.sh                                    # Clean uninstallation script
├── README.md                                       # Documentation & usage guide
├── LICENSE                                         # MIT License
└── root/                                           # Root filesystem overlay
    ├── etc/
    │   └── config/
    │       └── jodu52540                           # Default UCI configuration template
    ├── usr/
    │   ├── libexec/
    │   │   └── odu-data.sh                         # Core backend data & telnet bridge
    │   └── share/
    │       ├── luci/
    │       │   └── menu.d/
    │       │       └── luci-app-jodu52540-status.json   # LuCI menu entry (Status -> 5G Dashboard)
    │       └── rpcd/
    │           └── acl.d/
    │               └── luci-app-jodu52540-status.json   # RPCD ACL permissions
    └── www/
        └── luci-static/
            └── resources/
                └── view/
                    └── jodu52540/
                        └── status.js               # LuCI JavaScript client application
```

---

## 🔧 Manual Installation

If you prefer to install manually via SCP or terminal:

1. Clone or download this repository:
   ```sh
   git clone https://github.com/n8anyone/JODU52540-Status.git
   cd JODU52540-Status
   ```

2. Copy the files to your OpenWrt router:
   ```sh
   scp -r root/* root@192.168.1.1:/
   ```

3. SSH into your router and set permissions & reload services:
   ```sh
   chmod +x /usr/libexec/odu-data.sh
   /etc/init.d/rpcd restart
   rm -f /tmp/luci-indexcache* /tmp/luci-modulecache*
   touch /lib/apk/db/installed 2>/dev/null || touch /usr/lib/opkg/status 2>/dev/null
   /etc/init.d/uhttpd restart
   ```

---

## ⚙️ Configuration

### Via LuCI Web UI (Recommended)
Navigate to **Status** ➔ **5G Dashboard** and click **⚙️ ODU Credentials** in the top bar. Enter your settings and click **Save**.

### Via OpenWrt Command Line (UCI)
```sh
# Set ODU IP
uci set jodu52540.main.host='192.168.225.1'

# Set ODU Web Login
uci set jodu52540.main.username='Admin'
uci set jodu52540.main.password='YourODUPassword'

# Set Telnet Login (if required)
uci set jodu52540.main.telnet_user='root'
uci set jodu52540.main.telnet_password='YourTelnetPassword'

# Commit changes
uci commit jodu52540
```

---

## 🗑️ Uninstallation

To completely remove the application:

```sh
sh -c "$(curl -fsSL https://raw.githubusercontent.com/n8anyone/JODU52540-Status/main/uninstall.sh 2>/dev/null || wget -qO- https://raw.githubusercontent.com/n8anyone/JODU52540-Status/main/uninstall.sh)"
```

Or if you have the local repository:
```sh
sh ./uninstall.sh
```

---

## 🤝 Contributing

Contributions, bug reports, and pull requests are welcome! If you have hardware details or additional AT commands for other modem firmware revisions, feel free to submit an issue or PR.

---

## 📜 License

This project is licensed under the [MIT License](LICENSE).
