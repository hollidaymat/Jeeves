#!/bin/bash
# ============================================================================
# Jeeves Homelab Backup Script
# 
# Backs up all critical Docker volumes and PostgreSQL to /data/backups.
# Run as: jeeves user (owns /data)
# Schedule: cron daily at 2 AM
#
# Usage:
#   ./backup.sh              # Full backup (all volumes + postgres)
#   ./backup.sh postgres     # Postgres only
#   ./backup.sh volumes      # Volumes only
#   ./backup.sh cleanup      # Retention cleanup only
# ============================================================================

set -euo pipefail

# ── Configuration ──────────────────────────────────────────────────────────

BACKUP_DIR="/data/backups"
LOG_FILE="${BACKUP_DIR}/backup.log"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
DATE_DIR=$(date +"%Y-%m-%d")
TODAY_DIR="${BACKUP_DIR}/${DATE_DIR}"

# Retention
KEEP_DAILY=7
KEEP_WEEKLY=4
KEEP_MONTHLY=2

# Postgres container config
PG_CONTAINER="postgres"
PG_USER="jeeves"

# Signal notification (Jeeves web API)
SIGNAL_API="http://localhost:3847/api/message"
OWNER_NUMBER="${SIGNAL_OWNER_NUMBER:-}"

# Critical data volumes (P0/P1 -- back up every day)
CRITICAL_VOLUMES=(
    "vaultwarden_data"
    "postgres_data"
    "nextcloud_data"
    "paperless_data"
    "paperless_media"
)

# Config volumes (P2/P3 -- service configs, back up daily)
CONFIG_VOLUME_PATTERN="_config"

# ── Helpers ────────────────────────────────────────────────────────────────

log() {
    local level="$1"
    shift
    local msg="$*"
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] [${level}] ${msg}" | tee -a "${LOG_FILE}"
}

notify() {
    local msg="$1"
    log "NOTIFY" "${msg}"
    
    # Try Signal notification via Jeeves web API
    if [ -n "${OWNER_NUMBER}" ]; then
        curl -s -X POST "${SIGNAL_API}" \
            -H "Content-Type: application/json" \
            -d "{\"recipient\":\"${OWNER_NUMBER}\",\"content\":\"${msg}\"}" \
            >/dev/null 2>&1 || true
    fi
}

die() {
    log "FATAL" "$*"
    notify "BACKUP FAILED: $*"
    exit 1
}

human_size() {
    local bytes=$1
    if [ "${bytes}" -ge 1073741824 ]; then
        echo "$(echo "scale=1; ${bytes}/1073741824" | bc)GB"
    elif [ "${bytes}" -ge 1048576 ]; then
        echo "$(echo "scale=1; ${bytes}/1048576" | bc)MB"
    else
        echo "$(echo "scale=1; ${bytes}/1024" | bc)KB"
    fi
}

# ── Locking ────────────────────────────────────────────────────────────────

LOCK_FILE="/tmp/jeeves-backup.lock"

acquire_lock() {
    if [ -f "${LOCK_FILE}" ]; then
        local pid
        pid=$(cat "${LOCK_FILE}" 2>/dev/null || echo "")
        if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
            die "Another backup is running (PID ${pid})"
        fi
        log "WARN" "Stale lock file found, removing"
        rm -f "${LOCK_FILE}"
    fi
    echo $$ > "${LOCK_FILE}"
    trap 'rm -f "${LOCK_FILE}"' EXIT
}

# ── PostgreSQL Backup ──────────────────────────────────────────────────────

backup_postgres() {
    log "INFO" "Starting PostgreSQL backup..."
    
    local pg_dir="${TODAY_DIR}/postgres"
    mkdir -p "${pg_dir}"
    
    # Check container is running
    if ! docker ps --format '{{.Names}}' | grep -q "^${PG_CONTAINER}$"; then
        log "ERROR" "PostgreSQL container '${PG_CONTAINER}' is not running"
        return 1
    fi
    
    # Full database dump (all databases)
    local dump_file="${pg_dir}/all_databases_${TIMESTAMP}.sql"
    if docker exec "${PG_CONTAINER}" pg_dumpall -U "${PG_USER}" > "${dump_file}" 2>>"${LOG_FILE}"; then
        gzip "${dump_file}"
        local size
        size=$(stat -c%s "${dump_file}.gz" 2>/dev/null || echo "0")
        log "INFO" "PostgreSQL backup complete: $(human_size ${size})"
        
        # Checksum for verification
        sha256sum "${dump_file}.gz" > "${dump_file}.gz.sha256"
    else
        log "ERROR" "PostgreSQL dump failed"
        rm -f "${dump_file}"
        return 1
    fi
}

# ── Docker Volume Backup ──────────────────────────────────────────────────

backup_volume() {
    local volume="$1"
    local vol_dir="${TODAY_DIR}/volumes"
    mkdir -p "${vol_dir}"
    
    # Verify volume exists
    if ! docker volume inspect "${volume}" >/dev/null 2>&1; then
        log "WARN" "Volume '${volume}' does not exist, skipping"
        return 0
    fi
    
    local archive="${vol_dir}/${volume}_${TIMESTAMP}.tar.gz"
    
    log "INFO" "Backing up volume: ${volume}"
    
    if docker run --rm \
        -v "${volume}":/source:ro \
        -v "${vol_dir}":/backup \
        alpine \
        tar czf "/backup/${volume}_${TIMESTAMP}.tar.gz" -C /source . 2>>"${LOG_FILE}"; then
        
        local size
        size=$(stat -c%s "${archive}" 2>/dev/null || echo "0")
        log "INFO" "  ${volume}: $(human_size ${size})"
        
        # Checksum
        sha256sum "${archive}" > "${archive}.sha256"
    else
        log "ERROR" "  ${volume}: FAILED"
        rm -f "${archive}"
        return 1
    fi
}

backup_all_volumes() {
    log "INFO" "Starting volume backups..."
    
    local failed=0
    local total=0
    
    # Critical volumes first
    for vol in "${CRITICAL_VOLUMES[@]}"; do
        total=$((total + 1))
        if ! backup_volume "${vol}"; then
            failed=$((failed + 1))
        fi
    done
    
    # Config volumes (auto-discovered)
    while IFS= read -r vol; do
        [ -z "${vol}" ] && continue
        # Skip if already in critical list
        local skip=false
        for cv in "${CRITICAL_VOLUMES[@]}"; do
            if [ "${vol}" = "${cv}" ]; then
                skip=true
                break
            fi
        done
        if [ "${skip}" = true ]; then continue; fi
        
        total=$((total + 1))
        if ! backup_volume "${vol}"; then
            failed=$((failed + 1))
        fi
    done < <(docker volume ls -q | grep "${CONFIG_VOLUME_PATTERN}" 2>/dev/null)
    
    log "INFO" "Volume backups complete: $((total - failed))/${total} succeeded"
    
    if [ "${failed}" -gt 0 ]; then
        return 1
    fi
}

# ── Compose Stacks Backup ─────────────────────────────────────────────────

backup_stacks() {
    log "INFO" "Backing up compose stacks..."
    
    local stacks_dir="${TODAY_DIR}/stacks"
    mkdir -p "${stacks_dir}"
    
    if [ -d "/opt/stacks" ]; then
        tar czf "${stacks_dir}/stacks_${TIMESTAMP}.tar.gz" -C /opt/stacks . 2>>"${LOG_FILE}"
        local size
        size=$(stat -c%s "${stacks_dir}/stacks_${TIMESTAMP}.tar.gz" 2>/dev/null || echo "0")
        log "INFO" "  Stacks backup: $(human_size ${size})"
    else
        log "WARN" "/opt/stacks does not exist, skipping"
    fi
}

# ── Retention Cleanup ──────────────────────────────────────────────────────

cleanup_old_backups() {
    log "INFO" "Running retention cleanup..."
    
    local deleted=0
    local kept=0
    
    # List all backup date directories, newest first
    local all_dirs=()
    while IFS= read -r dir; do
        [ -z "${dir}" ] && continue
        # Only match YYYY-MM-DD directories
        local basename
        basename=$(basename "${dir}")
        if [[ "${basename}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}$ ]]; then
            all_dirs+=("${dir}")
        fi
    done < <(find "${BACKUP_DIR}" -maxdepth 1 -type d | sort -r)
    
    local total=${#all_dirs[@]}
    
    # Always keep at least 3 most recent regardless of policy
    local min_keep=3
    
    for i in "${!all_dirs[@]}"; do
        local dir="${all_dirs[$i]}"
        local basename
        basename=$(basename "${dir}")
        
        # Always keep minimum
        if [ "$((i))" -lt "${min_keep}" ]; then
            kept=$((kept + 1))
            continue
        fi
        
        # Keep daily backups (within KEEP_DAILY days)
        if [ "$((i))" -lt "${KEEP_DAILY}" ]; then
            kept=$((kept + 1))
            continue
        fi
        
        # Keep weekly backups (Sunday backups within KEEP_WEEKLY weeks)
        local day_of_week
        day_of_week=$(date -d "${basename}" +%u 2>/dev/null || echo "0")
        if [ "${day_of_week}" = "7" ] && [ "$((i))" -lt "$((KEEP_DAILY + KEEP_WEEKLY * 7))" ]; then
            kept=$((kept + 1))
            continue
        fi
        
        # Keep monthly backups (1st of month within KEEP_MONTHLY months)
        local day_of_month
        day_of_month=$(date -d "${basename}" +%d 2>/dev/null || echo "0")
        if [ "${day_of_month}" = "01" ] && [ "$((i))" -lt "$((KEEP_DAILY + KEEP_WEEKLY * 7 + KEEP_MONTHLY * 30))" ]; then
            kept=$((kept + 1))
            continue
        fi
        
        # Delete old backup
        log "INFO" "  Removing old backup: ${basename}"
        rm -rf "${dir}"
        deleted=$((deleted + 1))
    done
    
    log "INFO" "Cleanup complete: kept ${kept}, deleted ${deleted} of ${total} total"
}

# ── Disk Usage Check ───────────────────────────────────────────────────────

check_disk_usage() {
    local usage
    usage=$(df /data --output=pcent 2>/dev/null | tail -1 | tr -d ' %')
    
    if [ -n "${usage}" ] && [ "${usage}" -ge 85 ]; then
        notify "WARNING: /data disk is ${usage}% full. Backups may fail soon."
        log "WARN" "/data disk at ${usage}%"
    fi
}

# ── Summary ────────────────────────────────────────────────────────────────

generate_summary() {
    local start_time="$1"
    local end_time
    end_time=$(date +%s)
    local duration=$(( end_time - start_time ))
    
    local total_size=0
    if [ -d "${TODAY_DIR}" ]; then
        total_size=$(du -sb "${TODAY_DIR}" 2>/dev/null | cut -f1 || echo "0")
    fi
    
    local msg="Backup complete: $(human_size ${total_size}) in ${duration}s (${DATE_DIR})"
    log "INFO" "${msg}"
    
    # Only notify on failure or if backup is unusually large/small
    if [ "${BACKUP_ERRORS}" -gt 0 ]; then
        notify "BACKUP WARNING: ${BACKUP_ERRORS} error(s) during backup. Check logs."
    fi
}

# ── Main ───────────────────────────────────────────────────────────────────

main() {
    local mode="${1:-full}"
    local start_time
    start_time=$(date +%s)
    BACKUP_ERRORS=0
    
    # Setup
    mkdir -p "${BACKUP_DIR}" "${TODAY_DIR}"
    acquire_lock
    
    log "INFO" "=========================================="
    log "INFO" "Backup started: mode=${mode}"
    log "INFO" "=========================================="
    
    check_disk_usage
    
    case "${mode}" in
        full)
            backup_postgres || BACKUP_ERRORS=$((BACKUP_ERRORS + 1))
            backup_all_volumes || BACKUP_ERRORS=$((BACKUP_ERRORS + 1))
            backup_stacks || BACKUP_ERRORS=$((BACKUP_ERRORS + 1))
            cleanup_old_backups
            ;;
        postgres)
            backup_postgres || BACKUP_ERRORS=$((BACKUP_ERRORS + 1))
            ;;
        volumes)
            backup_all_volumes || BACKUP_ERRORS=$((BACKUP_ERRORS + 1))
            ;;
        cleanup)
            cleanup_old_backups
            ;;
        *)
            echo "Usage: $0 {full|postgres|volumes|cleanup}"
            exit 1
            ;;
    esac
    
    generate_summary "${start_time}"
    
    if [ "${BACKUP_ERRORS}" -gt 0 ]; then
        exit 1
    fi
}

main "$@"
