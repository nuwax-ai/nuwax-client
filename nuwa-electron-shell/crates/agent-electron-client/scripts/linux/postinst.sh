#!/bin/bash
# Nuwax deb/rpm 安装后启用 Electron SUID sandbox。
# electron-builder 25.1.8 将商业 productName=Nuwax 安装到 /opt/Nuwax。
# 仅处理本产品，不能扫描/修改同机 NuwaClaw 或任意外部目录。
set -e

fail() {
    echo "Nuwax post-install: $*" >&2
    exit 1
}

[ "$(id -u)" = "0" ] || fail "root privileges are required"
SANDBOX_PATH="/opt/Nuwax/chrome-sandbox"

# 不跟随父目录或文件链接，也不对可被普通用户替换的文件授予 SUID。
for INSTALL_DIR in / /opt /opt/Nuwax; do
    [ ! -L "$INSTALL_DIR" ] && [ -d "$INSTALL_DIR" ] || fail "unsafe installation directory: $INSTALL_DIR"
    DIR_INFO=$(stat -c '%u:%a' "$INSTALL_DIR") || fail "cannot inspect installation directory: $INSTALL_DIR"
    IFS=: read -r DIR_UID DIR_MODE <<< "$DIR_INFO"
    [[ "$DIR_UID" = "0" && "$DIR_MODE" =~ ^[0-7]{3,4}$ ]] || fail "untrusted installation directory owner: $INSTALL_DIR"
    (( (8#$DIR_MODE & 0022) == 0 )) || fail "writable installation directory: $INSTALL_DIR"
done

[ ! -L "$SANDBOX_PATH" ] && [ -f "$SANDBOX_PATH" ] || fail "missing or unsafe chrome-sandbox: $SANDBOX_PATH"
FILE_INFO=$(stat -c '%u:%a:%h' "$SANDBOX_PATH") || fail "cannot inspect chrome-sandbox"
IFS=: read -r FILE_UID FILE_MODE FILE_LINKS <<< "$FILE_INFO"
[[ "$FILE_UID" = "0" && "$FILE_MODE" =~ ^[0-7]{3,4}$ && "$FILE_LINKS" = "1" ]] || fail "untrusted chrome-sandbox owner or hard links"
(( (8#$FILE_MODE & 0022) == 0 )) || fail "writable chrome-sandbox"

# file 不是 deb/rpm 的保证依赖；缺少时保留 ELF magic 检查。
if command -v file >/dev/null 2>&1; then
    file "$SANDBOX_PATH" 2>/dev/null | grep -qE 'ELF.*(executable|shared object)' || fail "chrome-sandbox is not an ELF executable"
else
    ELF_HEADER=$(head -c 4 "$SANDBOX_PATH" | od -A n -t x1 | tr -d ' \n')
    [ "$ELF_HEADER" = "7f454c46" ] || fail "chrome-sandbox has no ELF header"
fi

chown root:root "$SANDBOX_PATH" || fail "cannot set chrome-sandbox owner"
[ "$(stat -c '%u:%g' "$SANDBOX_PATH")" = "0:0" ] || fail "chrome-sandbox owner verification failed"
chmod 4755 "$SANDBOX_PATH" || fail "cannot set chrome-sandbox permissions"
[ "$(stat -c '%u:%g:%a' "$SANDBOX_PATH")" = "0:0:4755" ] || fail "chrome-sandbox permission verification failed"
echo "Nuwax post-install: SUID sandbox enabled."
