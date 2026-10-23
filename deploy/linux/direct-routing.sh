#!/bin/sh
set -eu

action=${1:-}
case "$action" in
  add|delete) ;;
  *) printf '%s\n' '用法: direct-routing.sh add|delete' >&2; exit 2 ;;
esac

service_uid=$(id -u subconvert)
priority=5280
for family in -4 -6; do
  existing=$(/usr/sbin/ip "$family" rule show priority "$priority")
  if [ "$action" = add ]; then
    # long: 只让独立服务账号避开宿主机 TUN，保留更高优先级的本地/Tailscale 路由，不改变其他用户的代理链路。
    if [ -n "$existing" ]; then
      printf '%s\n' "路由优先级 $priority 已被占用，拒绝覆盖：$existing" >&2
      exit 1
    fi
    /usr/sbin/ip "$family" rule add priority "$priority" uidrange "$service_uid-$service_uid" lookup main
  elif [ -n "$existing" ]; then
    # long: 删除时必须同时匹配账号范围和主路由表，不能误删相同优先级下属于其他服务的规则。
    /usr/sbin/ip "$family" rule del priority "$priority" uidrange "$service_uid-$service_uid" lookup main
  fi
done
