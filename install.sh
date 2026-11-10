#!/bin/sh
# ==============================================================================
# JODU52540 5G Dashboard for OpenWrt LuCI - Installer
# Target: OpenWrt 21.02 / 22.03 / 23.05 / 24.10 / 25.12+ (opkg & apk supported)
# ==============================================================================

set -e

# Configuration
GITHUB_REPO="${GITHUB_REPO:-__REPO_OWNER__/JODU52540-Status}"
BRANCH="${BRANCH:-main}"
RAW_BASE="https://raw.githubusercontent.com/${GITHUB_REPO}/${BRANCH}/root"

echo "=================================================================="
echo "    🚀 Installing JODU52540 5G Dashboard for OpenWrt LuCI         "
echo "=================================================================="

# 1. Dependency checks (curl is required for ODU communication)
echo "[1/5] Checking system dependencies..."
NEED_CURL=0
if ! command -v curl >/dev/null 2>&1; then
    NEED_CURL=1
fi

if [ "$NEED_CURL" -eq 1 ]; then
    echo "  -> 'curl' is required for ODU API calls. Installing..."
    if command -v apk >/dev/null 2>&1; then
        apk update && apk add curl
    elif command -v opkg >/dev/null 2>&1; then
        opkg update && opkg install curl
    else
        echo "  ⚠️ Warning: Could not find opkg or apk. Please install 'curl' manually."
    fi
else
    echo "  ✓ 'curl' is already installed."
fi

# 2. Setup Directories
echo "[2/5] Creating directory structure..."
mkdir -p /etc/config
mkdir -p /usr/libexec
mkdir -p /usr/share/luci/menu.d
mkdir -p /usr/share/rpcd/acl.d
mkdir -p /www/luci-static/resources/view/jodu52540

# 3. Download or Copy Files
echo "[3/5] Installing application files..."

fetch_file() {
    rel_path="$1"
    target="/$rel_path"
    
    # Check if local file exists (running from git clone)
    if [ -f "./root/$rel_path" ]; then
        echo "  -> Installing $target (from local source)"
        cp -f "./root/$rel_path" "$target"
        return
    fi
    
    echo "  -> Downloading $target"
    url="${RAW_BASE}/${rel_path}"
    if command -v curl >/dev/null 2>&1; then
        curl -fsSL -k "$url" -o "$target"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -O "$target" "$url"
    elif command -v uclient-fetch >/dev/null 2>&1; then
        uclient-fetch -q -O "$target" "$url"
    else
        echo "  ❌ Error: Neither curl nor wget is available to download files."
        exit 1
    fi
}

# Install core backend
fetch_file "usr/libexec/odu-data.sh"
chmod +x /usr/libexec/odu-data.sh

# Install LuCI menu and ACL definitions
fetch_file "usr/share/luci/menu.d/luci-app-jodu52540-status.json"
fetch_file "usr/share/rpcd/acl.d/luci-app-jodu52540-status.json"

# Install LuCI Frontend View
fetch_file "www/luci-static/resources/view/jodu52540/status.js"

# Also support legacy /htdocs directory if separate from /www
if [ -d "/htdocs/luci-static/resources/view" ] && [ ! -L "/htdocs" ]; then
    mkdir -p /htdocs/luci-static/resources/view/jodu52540
    cp -f /www/luci-static/resources/view/jodu52540/status.js /htdocs/luci-static/resources/view/jodu52540/status.js
fi

# Install default config if not already present (preserve user credentials if updating)
if [ ! -f /etc/config/jodu52540 ]; then
    fetch_file "etc/config/jodu52540"
    echo "  ✓ Installed default UCI configuration (/etc/config/jodu52540)"
else
    echo "  ℹ️ Existing /etc/config/jodu52540 detected. Preserving your configuration."
fi

# 4. Permissions & Service Restarts
echo "[4/5] Reloading rpcd permissions & clearing LuCI cache..."
/etc/init.d/rpcd restart 2>/dev/null || true

# Purge LuCI caches
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache* /tmp/luci-sessions* 2>/dev/null || true

# Bump package db timestamp to bust browser cache
touch /lib/apk/db/installed 2>/dev/null || touch /usr/lib/opkg/status 2>/dev/null || true

# Restart web server (uhttpd / nginx)
echo "[5/5] Restarting web server..."
if [ -f /etc/init.d/uhttpd ]; then
    /etc/init.d/uhttpd restart 2>/dev/null || true
elif [ -f /etc/init.d/nginx ]; then
    /etc/init.d/nginx restart 2>/dev/null || true
fi

echo "=================================================================="
echo "    🎉 Installation Complete!                                     "
echo "=================================================================="
echo "To view your dashboard:"
echo " 1. Log in to your OpenWrt Web Interface (LuCI)."
echo " 2. Navigate to: Status -> 5G Dashboard"
echo " 3. Click '⚙️ ODU Credentials' to configure your ODU IP & Password."
echo "=================================================================="
