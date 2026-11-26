#!/usr/bin/env bash
# agent-pipeline 远程一键安装脚本
# 用法：bash <(curl -fsSL https://raw.githubusercontent.com/trexwb/agent-pipeline/main/scripts/install-remote.sh)
#
# 选项：
#   --version <x.y.z>   安装指定版本（默认 latest）
#   --platform <列表>   逗号分隔：qoder / workbuddy / codebuddy / zcode / marvis / auto / all
#                       auto=只装已检测到的宿主；all=所有宿主（默认 auto）
#   --force             覆盖已存在的安装
#   --uninstall         卸载
#   --dry-run           只打印计划，不执行
#
# 零依赖：只需 bash + curl + unzip（macOS/Linux 自带），无需 Node

set -eo pipefail

SKILL_NAME="agent-pipeline"
GITHUB_REPO="trexwb/agent-pipeline"
API_BASE="https://api.github.com/repos"
RELEASE_BASE="https://github.com"
# GitHub 镜像（国内加速，可选）
GITHUB_MIRROR="${GITHUB_MIRROR:-}"  # 例如：https://ghproxy.com/ 或 https://mirror.ghproxy.com/
HOME_DIR="$HOME"

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

# ---------- 参数解析 ----------
VERSION=""
PLATFORM_ARG="auto"
FORCE=false
UNINSTALL=false
DRY_RUN=false

while [[ $# -gt 0 ]]; do
    case "$1" in
        --version)    VERSION="$2"; shift 2 ;;
        --platform)   PLATFORM_ARG="$2"; shift 2 ;;
        --force)      FORCE=true; shift ;;
        --uninstall)  UNINSTALL=true; shift ;;
        --dry-run)    DRY_RUN=true; shift ;;
        --help|-h)
            head -14 "$0" | tail -11
            exit 0
            ;;
        *)
            echo -e "${RED}未知参数：$1${NC}"
            exit 1
            ;;
    esac
done

# ---------- 工具函数 ----------
log_info()  { echo -e "${GREEN}[信息]${NC} $*" >&2; }
log_warn()  { echo -e "${YELLOW}[警告]${NC} $*" >&2; }
log_error() { echo -e "${RED}[错误]${NC} $*" >&2; }
log_dry()   { echo -e "${CYAN}[演练]${NC} $*" >&2; }

# 获取平台目录
get_platform_dir() {
    local platform="$1"
    case "$platform" in
        qoder)       echo "$HOME_DIR/.qoder-cn/skills/$SKILL_NAME" ;;
        qoder-intl)  echo "$HOME_DIR/.qoder/skills/$SKILL_NAME" ;;
        workbuddy)   echo "$HOME_DIR/.workbuddy/skills/$SKILL_NAME" ;;
        codebuddy)   echo "$HOME_DIR/.codebuddy/skills/$SKILL_NAME" ;;
        zcode)       echo "$HOME_DIR/.zcode/skills/$SKILL_NAME" ;;
        marvis)      echo "$HOME_DIR/.marvis/skills/custom/$SKILL_NAME" ;;
        common)      echo "$HOME_DIR/.agents/skills/$SKILL_NAME" ;;
        *)           echo "" ;;
    esac
}

# 获取平台检测目录
get_platform_detect() {
    local platform="$1"
    case "$platform" in
        qoder)       echo "$HOME_DIR/.qoder-cn" ;;
        qoder-intl)  echo "$HOME_DIR/.qoder" ;;
        workbuddy)   echo "$HOME_DIR/.workbuddy" ;;
        codebuddy)   echo "$HOME_DIR/.codebuddy" ;;
        zcode)       echo "$HOME_DIR/.zcode" ;;
        marvis)      echo "$HOME_DIR/.marvis" ;;
        common)      echo "$HOME_DIR/.agents" ;;
        *)           echo "" ;;
    esac
}

# 获取平台标签
get_platform_label() {
    local platform="$1"
    case "$platform" in
        qoder)       echo "Qoder (国内版)" ;;
        qoder-intl)  echo "Qoder (国际版)" ;;
        workbuddy)   echo "WorkBuddy" ;;
        codebuddy)   echo "CodeBuddy" ;;
        zcode)       echo "zCode" ;;
        marvis)      echo "Marvis" ;;
        common)      echo "通用 .agents" ;;
        *)           echo "$platform" ;;
    esac
}

# 检测已安装的宿主
detect_platforms() {
    local detected=""
    for p in qoder qoder-intl workbuddy codebuddy zcode marvis common; do
        local detect_dir
        detect_dir=$(get_platform_detect "$p")
        if [[ -d "$detect_dir" ]]; then
            if [[ -n "$detected" ]]; then
                detected="$detected $p"
            else
                detected="$p"
            fi
        fi
    done
    echo "$detected"
}

# 解析 --platform 参数
resolve_platforms() {
    local arg="$1"
    if [[ "$arg" == "auto" ]]; then
        detect_platforms
    elif [[ "$arg" == "all" ]]; then
        echo "qoder qoder-intl workbuddy codebuddy zcode marvis common"
    else
        # 逗号分隔转空格
        echo "$arg" | tr ',' ' '
    fi
}

# 获取最新版本号
get_latest_version() {
    local info
    local api_url="${GITHUB_MIRROR}${API_BASE}/$GITHUB_REPO/releases/latest"
    # 尝试获取 Release 信息，如果失败则回退到 main 分支
    info=$(curl -fsSL --connect-timeout 30 --max-time 60 "$api_url" 2>/dev/null) || {
        echo "main"
        return
    }
    # 提取 tag_name，去掉前缀 v
    local tag
    tag=$(echo "$info" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"tag_name": *"\([^"]*\)".*/\1/')
    if [[ -z "$tag" || "$tag" == *"message"* ]]; then
        # 没有 Release，回退到 main 分支
        echo "main"
    else
        echo "${tag#v}"
    fi
}

# 下载并解压
download_and_extract() {
    local ver="$1"
    local tmp_dir
    tmp_dir=$(mktemp -d -t "${SKILL_NAME}-XXXXXX")
    local extract_dir="$tmp_dir/extracted"

    if [[ "$ver" == "main" ]]; then
        # 从 main 分支下载 zip
        local download_url="${GITHUB_MIRROR}${RELEASE_BASE}/$GITHUB_REPO/archive/refs/heads/main.zip"
        log_info "从 main 分支下载（无 Release 时回退）"
        if $DRY_RUN; then
            log_dry "将下载到 $tmp_dir"
            echo "$tmp_dir"
            return
        fi
        if ! curl -fL --connect-timeout 30 --max-time 300 -o "$tmp_dir/main.zip" "$download_url" 2>/dev/null; then
            rm -rf "$tmp_dir"
            log_error "下载失败，请检查仓库是否存在或网络连接"
            log_error "提示：可设置 GITHUB_MIRROR 环境变量使用镜像加速"
            log_error "  例如：export GITHUB_MIRROR=https://ghproxy.com/"
            exit 1
        fi
        mkdir -p "$extract_dir"
        unzip -q "$tmp_dir/main.zip" -d "$extract_dir"
        # GitHub archive zip 会解压到 agent-pipeline-main/ 子目录
        if [[ -d "$extract_dir/agent-pipeline-main" ]]; then
            # 移动所有文件（包括隐藏文件）到 extract_dir
            (cd "$extract_dir/agent-pipeline-main" && find . -mindepth 1 -maxdepth 1 -exec mv {} "$extract_dir/" \;)
            rmdir "$extract_dir/agent-pipeline-main" 2>/dev/null || true
        fi
    else
        # 从 Release 下载
        local zip_name="${SKILL_NAME}-${ver}.zip"
        local download_url="${GITHUB_MIRROR}${RELEASE_BASE}/$GITHUB_REPO/releases/download/v${ver}/${zip_name}"
        local zip_path="$tmp_dir/$zip_name"

        log_info "下载 v${ver}：$download_url"
        if $DRY_RUN; then
            log_dry "将下载到 $tmp_dir"
            echo "$tmp_dir"
            return
        fi
        if ! curl -fL --connect-timeout 30 --max-time 300 -o "$zip_path" "$download_url" 2>/dev/null; then
            rm -rf "$tmp_dir"
            log_error "下载失败，请检查版本 v${ver} 是否存在"
            log_error "提示：可设置 GITHUB_MIRROR 环境变量使用镜像加速"
            exit 1
        fi
        mkdir -p "$extract_dir"
        unzip -q "$zip_path" -d "$extract_dir"
    fi

    log_info "解压完成"
    echo "$extract_dir"
}

# 安装到指定目录
install_to() {
    local src="$1"
    local dest="$2"
    local platform="$3"

    local label
    label=$(get_platform_label "$platform")

    if [[ -d "$dest" ]]; then
        if $FORCE; then
            if $DRY_RUN; then
                log_dry "将覆盖 $label → $dest"
                return 0
            fi
            rm -rf "$dest"
            log_info "覆盖安装 $label → $dest"
        else
            log_warn "跳过 $label：$dest 已存在（使用 --force 覆盖）"
            return 0
        fi
    else
        if $DRY_RUN; then
            log_dry "将安装 $label → $dest"
            return 0
        fi
        log_info "安装 $label → $dest"
    fi

    mkdir -p "$dest"
    # 复制文件，排除不需要的目录
    if command -v rsync &>/dev/null; then
        rsync -a --exclude='.git' --exclude='.github' --exclude='node_modules' \
            --exclude='.DS_Store' --exclude='pipeline-output' \
            "$src/" "$dest/" 2>/dev/null || {
            log_error "复制失败：$dest"
            return 1
        }
    else
        # 回退到 cp
        (cd "$src" && find . -type f \
            ! -path './.git/*' \
            ! -path './.github/*' \
            ! -path './node_modules/*' \
            ! -name '.DS_Store' \
            ! -path './pipeline-output/*' \
            -exec cp --parents {} "$dest/" \; 2>/dev/null) || {
            log_error "复制失败：$dest"
            return 1
        }
    fi
    return 0
}

# 卸载
uninstall_from() {
    local dest="$1"
    local platform="$2"
    local label
    label=$(get_platform_label "$platform")

    if [[ ! -d "$dest" ]]; then
        log_warn "跳过 $label：$dest 不存在"
        return 0
    fi

    # 确认是我们的 skill
    if [[ ! -f "$dest/SKILL.md" ]] || ! grep -q "name:.*agent-pipeline" "$dest/SKILL.md" 2>/dev/null; then
        log_warn "跳过 $label：$dest 不是 $SKILL_NAME"
        return 0
    fi

    if $DRY_RUN; then
        log_dry "将卸载 $label：$dest"
        return 0
    fi

    rm -rf "$dest"
    log_info "卸载 $label：$dest"
}

# ---------- 主流程 ----------
main() {
    echo ""
    echo "========================================"
    echo "  $SKILL_NAME 远程安装器"
    echo "========================================"
    echo ""

    # 确定版本
    if [[ -z "$VERSION" ]]; then
        log_info "获取最新版本..."
        VERSION=$(get_latest_version)
        if [[ -z "$VERSION" ]]; then
            log_error "无法获取版本号"
            exit 1
        fi
    fi
    if [[ "$VERSION" == "main" ]]; then
        log_info "目标版本：main（开发版，从 main 分支下载）"
    else
        log_info "目标版本：v${VERSION}"
    fi

    # 确定目标平台
    local platforms
    platforms=$(resolve_platforms "$PLATFORM_ARG")
    if [[ -z "$platforms" ]]; then
        log_error "未检测到任何已安装的宿主，请使用 --platform 指定"
        log_error "可用平台：qoder / workbuddy / codebuddy / zcode / marvis / all"
        exit 1
    fi
    log_info "目标平台：$platforms"

    # 卸载模式
    if $UNINSTALL; then
        for p in $platforms; do
            local dest
            dest=$(get_platform_dir "$p")
            uninstall_from "$dest" "$p"
        done
        log_info "卸载完成"
        return
    fi

    # 下载
    local extract_dir
    extract_dir=$(download_and_extract "$VERSION")
    if $DRY_RUN; then
        for p in $platforms; do
            local dest
            dest=$(get_platform_dir "$p")
            install_to "$extract_dir" "$dest" "$p"
        done
        return
    fi

    # 安装到各平台
    local ok=0 fail=0 skip=0
    for p in $platforms; do
        local dest
        dest=$(get_platform_dir "$p")
        if [[ -d "$dest" ]] && ! $FORCE; then
            log_warn "跳过 $(get_platform_label "$p")：$dest 已存在"
            skip=$((skip + 1))
            continue
        fi
        if install_to "$extract_dir" "$dest" "$p"; then
            ok=$((ok + 1))
        else
            fail=$((fail + 1))
        fi
    done

    # 清理临时目录
    local tmp_parent
    tmp_parent=$(dirname "$extract_dir")
    rm -rf "$tmp_parent"

    echo ""
    log_info "完成：${ok} 项成功，${skip} 项跳过，${fail} 项失败"
    if [[ $ok -gt 0 ]]; then
        log_info "提示：部分宿主需重启或执行 /skills reload 才能发现新 skill"
    fi
}

main
