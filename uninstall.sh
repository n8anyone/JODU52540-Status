#!/bin/sh
# ==============================================================================
# JODU52540 5G Dashboard for OpenWrt LuCI - Uninstaller
# ==============================================================================

echo "=================================================================="
echo "    🗑️ Uninstalling JODU52540 5G Dashboard...                    "
echo "=================================================================="

echo "[1/3] Removing installed files..."
rm -f /usr/libexec/odu-data.sh
rm -f /usr/share/luci/menu.d/luci-app-jodu52540-status.json
rm -f /usr/share/rpcd/acl.d/luci-app-jodu52540-status.json
rm -rf /www/luci-static/resources/view/jodu52540
rm -rf /htdocs/luci-static/resources/view/jodu52540 2>/dev/null || true

printf "Do you also want to remove /etc/config/jodu52540 (credentials & settings)? [y/N] "
read -r yn
case "$yn" in
    [Yy]* ) rm -f /etc/config/jodu52540; echo "  ✓ Removed configuration file.";;
    * ) echo "  ℹ️ Preserved /etc/config/jodu52540";;
esac

echo "[2/3] Reloading rpcd and clearing LuCI cache..."
/etc/init.d/rpcd restart 2>/dev/null || true
rm -f /tmp/luci-indexcache* /tmp/luci-modulecache* /tmp/luci-sessions* 2>/dev/null || true
touch /lib/apk/db/installed 2>/dev/null || touch /usr/lib/opkg/status 2>/dev/null || true

echo "[3/3] Restarting web server..."
if [ -f /etc/init.d/uhttpd ]; then
    /etc/init.d/uhttpd restart 2>/dev/null || true
elif [ -f /etc/init.d/nginx ]; then
    /etc/init.d/nginx restart 2>/dev/null || true
fi

echo "=================================================================="
echo "    ✓ JODU52540 5G Dashboard has been uninstalled.               "
echo "=================================================================="
