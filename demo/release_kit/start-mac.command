#!/bin/bash
# 广州 · 天河 demo：在本机开一个小服务器并打开浏览器（macOS 自带 Perl，不用装任何东西）。
cd "$(dirname "$0")" || exit 1
exec /usr/bin/perl tools/server.pl
