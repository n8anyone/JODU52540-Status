#!/bin/sh
# ==============================================================================
# JODU52540-Status — Backend Data & Control Bridge
# https://github.com/JODU52540-Status
# ==============================================================================

ACTION=$1
ID=$RANDOM

# ── Load Configuration from UCI (jodu52540 / jodu5164x) ──
CFG="jodu52540"
[ -f /etc/config/jodu52540 ] || CFG="jodu5164x"

ODU_IP=$(uci -q get ${CFG}.main.host)
[ -z "$ODU_IP" ] && ODU_IP="192.168.225.1"

ODU_WEB_USER=$(uci -q get ${CFG}.main.username)
[ -z "$ODU_WEB_USER" ] && ODU_WEB_USER="Admin"

ODU_WEB_PASS=$(uci -q get ${CFG}.main.password)

ODU_TELNET_PORT=$(uci -q get ${CFG}.main.telnet_port)
[ -z "$ODU_TELNET_PORT" ] && ODU_TELNET_PORT="23"

ODU_TELNET_USER=$(uci -q get ${CFG}.main.telnet_user)
[ -z "$ODU_TELNET_USER" ] && ODU_TELNET_USER="root"

ODU_TELNET_PASS=$(uci -q get ${CFG}.main.telnet_password)
[ "$ODU_TELNET_PASS" = "0" ] && ODU_TELNET_PASS=""

# ── Action: get_config ──
if [ "$ACTION" = "get_config" ]; then
    ESC_HOST=$(printf '%s' "$ODU_IP" | sed 's/"/\\"/g')
    ESC_USER=$(printf '%s' "$ODU_WEB_USER" | sed 's/"/\\"/g')
    ESC_PASS=$(printf '%s' "$ODU_WEB_PASS" | sed 's/"/\\"/g')
    ESC_TPORT=$(printf '%s' "$ODU_TELNET_PORT" | sed 's/"/\\"/g')
    ESC_TUSER=$(printf '%s' "$ODU_TELNET_USER" | sed 's/"/\\"/g')
    ESC_TPASS=$(printf '%s' "$ODU_TELNET_PASS" | sed 's/"/\\"/g')

    printf '{"host":"%s","username":"%s","password":"%s","telnet_port":"%s","telnet_user":"%s","telnet_password":"%s"}\n' \
        "$ESC_HOST" "$ESC_USER" "$ESC_PASS" "$ESC_TPORT" "$ESC_TUSER" "$ESC_TPASS"
    exit 0
fi

# ── Action: set_config ──
if [ "$ACTION" = "set_config" ]; then
    NEW_HOST="$2"
    NEW_USER="$3"
    NEW_PASS="$4"
    NEW_TPASS="$5"
    NEW_TUSER="$6"
    NEW_TPORT="$7"

    [ -z "$NEW_HOST" ] && NEW_HOST="192.168.225.1"
    [ -z "$NEW_USER" ] && NEW_USER="Admin"
    [ -z "$NEW_TUSER" ] && NEW_TUSER="root"
    [ -z "$NEW_TPORT" ] && NEW_TPORT="23"

    for c in jodu52540 jodu5164x; do
        [ -f "/etc/config/$c" ] || touch "/etc/config/$c"
        uci -q get "$c.main" >/dev/null 2>&1 || uci set "$c.main=main"
        uci set "$c.main.host=$NEW_HOST"
        uci set "$c.main.username=$NEW_USER"
        uci set "$c.main.password=$NEW_PASS"
        uci set "$c.main.telnet_password=$NEW_TPASS"
        uci set "$c.main.telnet_user=$NEW_TUSER"
        uci set "$c.main.telnet_port=$NEW_TPORT"
        uci commit "$c"
    done

    echo '{"status":"OK","message":"Configuration saved successfully"}'
    exit 0
fi

# ── ODU Temperature via Telnet ──
if [ "$ACTION" = "temperature" ] || [ "$ACTION" = "temp" ]; then
    REMOTE_CMD='for z in /sys/class/thermal/thermal_zone*; do t=$(cat $z/temp 2>/dev/null); n=$(cat $z/type 2>/dev/null); [ "$t" -gt 0 ] 2>/dev/null && echo "$n: $((t/1000))°C"; done'

    # Fetch via nc over telnet
    RAW_OUTPUT=$(
    {
        sleep 1
        printf "%s\n" "$REMOTE_CMD"
        sleep 2
        printf "exit\n"
        sleep 1
    } | nc "$ODU_IP" "$ODU_TELNET_PORT" 2>/dev/null
    )

    # Strip telnet negotiation bytes
    RAW_OUTPUT=$(echo "$RAW_OUTPUT" | tr -cd '\11\12\15\40-\176\302\260')

    # Extract only lines that look like "name: number°C" or "name: number"
    TEMP_LINES=$(echo "$RAW_OUTPUT" | grep -E '^[a-zA-Z0-9_-]+:[ ]*[0-9]+')

    # Build JSON using awk
    JSON=$(echo "$TEMP_LINES" | awk -F':' '
    BEGIN { first=1; printf "{\"zones\":[" }
    {
        t_name=$1
        gsub(/[^0-9.-]/, "", $2)
        t_val=$2 + 0
        if (t_name == "" || t_val <= 0 || t_val >= 150) next
        if (!first) printf ","
        printf "{\"type\":\"%s\",\"temp\":\"%s\"}", t_name, t_val
        first=0
    }
    END { printf "]}" }
    ')
    printf '%s\n' "$JSON"
    exit 0
fi

if [ "$ACTION" = "stats" ]; then
    wan_line=$(grep "wan:" /proc/net/dev)
    if [ -n "$wan_line" ]; then
        rx_bytes=$(echo "$wan_line" | awk -F: '{print $2}' | awk '{print $1}')
        tx_bytes=$(echo "$wan_line" | awk -F: '{print $2}' | awk '{print $9}')
        echo "{\"rx_bytes\":\"$rx_bytes\", \"tx_bytes\":\"$tx_bytes\"}"
    else
        echo "{}"
    fi
    exit 0
fi

# ── QCMAP CLI via Telnet ──
if [ "$ACTION" = "qcmap" ]; then
    CMD="${2:-QCMAP_CLI}"
    DYN_INPUT="$3"
    IP="$ODU_IP"
    USER="$ODU_TELNET_USER"
    PASS="$ODU_TELNET_PASS"
    PORT="$ODU_TELNET_PORT"

    # Map predefined action keys to their exact shell/AT/QCMAP commands
    case "$CMD" in
        "imei")           REAL_CMD="cat /dev/smd8 > /tmp/at & RPID=\$!; sleep 0.2; printf 'AT+CGSN\r\n' > /dev/smd8; sleep 1; kill \$RPID 2>/dev/null; cat /tmp/at" ;;
        "firmware")       REAL_CMD="cat /dev/smd8 > /tmp/at & RPID=\$!; sleep 0.2; printf 'AT+CGMR\r\n' > /dev/smd8; sleep 1; kill \$RPID 2>/dev/null; cat /tmp/at" ;;
        "signal_csq")     REAL_CMD="cat /dev/smd8 > /tmp/at & RPID=\$!; sleep 0.2; printf 'AT+CSQ\r\n' > /dev/smd8; sleep 1; kill \$RPID 2>/dev/null; cat /tmp/at" ;;
        "operator_info")  REAL_CMD="cat /dev/smd8 > /tmp/at & RPID=\$!; sleep 0.2; printf 'AT+COPS?\r\n' > /dev/smd8; sleep 1; kill \$RPID 2>/dev/null; cat /tmp/at" ;;
        "interfaces")     REAL_CMD="ifconfig -a" ;;
        "routes")         REAL_CMD="ip route" ;;
        "ping_test")      REAL_CMD="ping -c 3 1.1.1.1" ;;
        "uptime")         REAL_CMD="uptime" ;;
        "conntrack")      REAL_CMD="cat /proc/net/nf_conntrack 2>/dev/null | head -n 30 || netstat -tun" ;;
        "qcmap_1")        REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="1" ;;
        "qcmap_2")        REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="2" ;;
        "qcmap_3")        REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="3" ;;
        "qcmap_4")        REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="4" ;;
        "qcmap_5")        REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="5" ;;
        "qcmap_6")        REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="6" ;;
        "qcmap_7")        REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="7" ;;
        "qcmap_8")        REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="8" ;;
        "qcmap_9")        REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="9" ;;
        "qcmap_10")       REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="10" ;;
        "qcmap_11")       REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="11" ;;
        "qcmap_7_2")      REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="7\n2" ;;
        "qcmap_7_5")      REAL_CMD="QCMAP_CLI" ; EXTRA_INPUT="7\n5" ;;
        "cdm_manual")     REAL_CMD="/usr/bin/cellular_device_manager_demo" ; EXTRA_INPUT="$DYN_INPUT" ;;
        "cdm_1")          REAL_CMD="/usr/bin/cellular_device_manager_demo" ; EXTRA_INPUT="01" ;;
        "cdm_2")          REAL_CMD="/usr/bin/cellular_device_manager_demo" ; EXTRA_INPUT="02" ;;
        "cdm_3")          REAL_CMD="/usr/bin/cellular_device_manager_demo" ; EXTRA_INPUT="03" ;;
        "cdm_4")          REAL_CMD="/usr/bin/cellular_device_manager_demo" ; EXTRA_INPUT="04" ;;
        "cdm_5")          REAL_CMD="/usr/bin/cellular_device_manager_demo" ; EXTRA_INPUT="05" ;;
        "cdm_6")          REAL_CMD="/usr/bin/cellular_device_manager_demo" ; EXTRA_INPUT="06" ;;
        "cdm_7")          REAL_CMD="/usr/bin/cellular_device_manager_demo" ; EXTRA_INPUT="07" ;;
        "cdm_8")          REAL_CMD="/usr/bin/cellular_device_manager_demo" ; EXTRA_INPUT="08" ;;
        "cdm_9")          REAL_CMD="/usr/bin/cellular_device_manager_demo" ; EXTRA_INPUT="09" ;;
        "cdm_10")         REAL_CMD="/usr/bin/cellular_device_manager_demo" ; EXTRA_INPUT="10" ;;
        *)                REAL_CMD="$CMD" ;;
    esac

    [ -z "$REAL_CMD" ] && REAL_CMD="QCMAP_CLI"

    # Send command over telnet session with proper CRLF line endings
    OUTPUT=$(
    {
        sleep 1
        [ -n "$USER" ] && printf "%s\n" "$USER"
        [ -n "$PASS" ] && { sleep 1; printf "%s\n" "$PASS"; }
        sleep 1
        printf "%s\n" "$REAL_CMD"
        sleep 2
        if [ -n "$EXTRA_INPUT" ]; then
            printf "%b\n" "$EXTRA_INPUT"
            sleep 2
        fi
        printf "\003\n"
        sleep 1
        printf "exit\n"
        sleep 1
    } | nc "$IP" "$PORT" 2>/dev/null
    )

    # Fallback to telnet if nc fails
    if [ -z "$OUTPUT" ]; then
        OUTPUT=$(
        {
            sleep 1
            [ -n "$USER" ] && printf "%s\n" "$USER"
            [ -n "$PASS" ] && { sleep 1; printf "%s\n" "$PASS"; }
            sleep 1
            printf "%s\n" "$REAL_CMD"
            sleep 2
            if [ -n "$EXTRA_INPUT" ]; then
                printf "%b\n" "$EXTRA_INPUT"
                sleep 2
            fi
            printf "\003\n"
            sleep 1
            printf "exit\n"
            sleep 1
        } | telnet "$IP" "$PORT" 2>/dev/null
        )
    fi

    # Strip telnet negotiation bytes (non-ASCII)
    OUTPUT=$(echo "$OUTPUT" | tr -cd '\11\12\15\40-\176')

    # Remove the MoTD, user/pass echo, and exit
    OUTPUT=$(echo "$OUTPUT" | sed 's/QTI Linux reference nogplv3 distro targeting performance builds. HFCL-5GCPE.[0-9.]* sdxlemur//g')
    OUTPUT=$(echo "$OUTPUT" | sed -e 's/root@[a-zA-Z0-9_-]*:[^#$]*[#$] //g' -e "s/$USER//g" -e 's/root//g' -e 's/exit//g')
    [ -n "$PASS" ] && OUTPUT=$(echo "$OUTPUT" | sed "s/$PASS//g")
    
    # Remove the echoed command itself
    OUTPUT=$(echo "$OUTPUT" | grep -F -v "$REAL_CMD")
    if [ -n "$EXTRA_INPUT" ]; then
        OUTPUT=$(echo "$OUTPUT" | grep -F -v "$EXTRA_INPUT")
    fi

    # Diagnostic fallback if no data
    if [ -z "$OUTPUT" ] || [ -z "$(echo "$OUTPUT" | tr -d ' \n\r')" ]; then
        OUTPUT="⚠️ Connected to $IP:$PORT, but no output was returned for: $REAL_CMD"
    fi

    # Escape output for valid JSON string
    CLEAN=$(echo "$OUTPUT" | tr -d '\r' | sed 's/\\/\\\\/g' | sed 's/"/\\"/g' | awk '{printf "%s\\n", $0}')
    printf '{"status":"OK","output":"%s","cmd":"%s"}\n' "$CLEAN" "$REAL_CMD"
    exit 0
fi

# ── Web CGI Interface (GetNetworkStatus, etc.) ──
AUTH_URL="https://${ODU_IP}/cgi-bin/qcmap_auth"
CGI_URL="https://${ODU_IP}/cgi-bin/QCMAP_HFCL_CGI_Interface"

# Perform login to get token with URL-encoded parameters
AUTH_RES=$(curl -s -k -X POST \
    --data-urlencode "type=login" \
    --data-urlencode "pwd=$ODU_WEB_PASS" \
    --data-urlencode "timeout=null" \
    --data-urlencode "user=$ODU_WEB_USER" \
    "$AUTH_URL")

# Extract token using sed
TOKEN=$(echo "$AUTH_RES" | sed -n 's/.*"token":"\([^"]*\)".*/\1/p')

if [ -z "$TOKEN" ]; then
    echo "{\"error\": \"Could not get token from ODU. Auth response: $AUTH_RES\"}"
    exit 1
fi

if [ "$ACTION" = "network" ]; then
    curl -s -k -X POST -d "Page=GetNetworkStatus&id=$ID&token=$TOKEN" "$CGI_URL"
elif [ "$ACTION" = "neighbour" ]; then
    curl -s -k -X POST -d "Page=GetNeighbourStatus&id=$ID&token=$TOKEN" "$CGI_URL"
elif [ "$ACTION" = "deviceinfo" ]; then
    curl -s -k -X POST -d "Page=GetDeviceInfo&id=$ID&token=$TOKEN" "$CGI_URL"
elif [ "$ACTION" = "utilization" ]; then
    curl -s -k -X POST -d "Page=GetDeviceUtilization1&id=$ID&token=$TOKEN" "$CGI_URL"
elif [ "$ACTION" = "sms" ]; then
    curl -s -k -X POST -d "Page=GetInboxSMS&id=$ID&token=$TOKEN" "$CGI_URL"
elif [ "$ACTION" = "reboot" ]; then
    curl -s -k -X POST -H "Content-Type: application/json" -d "{\"do_reboot\":true, \"token\":\"token=$TOKEN\"}" "$CGI_URL"
fi
