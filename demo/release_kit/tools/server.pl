#!/usr/bin/perl
# Tiny static file server for the Tianhe demo (macOS / Linux, core Perl only): serves ../game on
# 127.0.0.1 (the first free port from 4299), opens the browser, runs until the window is closed.
# One forked child per connection, so an idle speculative connection from the browser never blocks the rest.
use strict;
use warnings;
use utf8;
use IO::Socket::INET;
use File::Basename qw(dirname);
use Cwd qw(abs_path);

binmode STDOUT, ':encoding(UTF-8)';
$| = 1;
my $root = abs_path(dirname(abs_path($0)) . '/../game');
my %mime = (
  html => 'text/html; charset=utf-8', js => 'text/javascript; charset=utf-8', mjs => 'text/javascript; charset=utf-8',
  css => 'text/css; charset=utf-8', json => 'application/json; charset=utf-8', glb => 'model/gltf-binary',
  gltf => 'model/gltf+json', bin => 'application/octet-stream', wasm => 'application/wasm', png => 'image/png',
  jpg => 'image/jpeg', jpeg => 'image/jpeg', webp => 'image/webp', svg => 'image/svg+xml', ktx2 => 'image/ktx2',
  txt => 'text/plain; charset=utf-8', ico => 'image/x-icon', mp3 => 'audio/mpeg', ogg => 'audio/ogg', wav => 'audio/wav',
);

my ($srv, $port);
for my $p (4299 .. 4399) {
  $srv = IO::Socket::INET->new(LocalAddr => '127.0.0.1', LocalPort => $p, Listen => 64, ReuseAddr => 1, Proto => 'tcp');
  if ($srv) { $port = $p; last; }
}
die "找不到空闲端口（4299–4399 都被占用了）\n" unless $srv;

my $url = "http://127.0.0.1:$port/";
print "\n  广州 · 天河 demo 已启动：$url\n\n";
print "  浏览器没有自动打开的话，把上面的地址复制到 Chrome / Edge 里。\n";
print "  玩的时候别关这个窗口；关掉窗口（或按 Ctrl+C）游戏就停了。\n\n";
unless ($ENV{TIANHE_NO_OPEN}) {
  system('open', $url) if $^O eq 'darwin';
  system('xdg-open', $url) if $^O eq 'linux';
}

$SIG{CHLD} = 'IGNORE';
$SIG{PIPE} = 'IGNORE';
while (1) {
  my $c = $srv->accept or next;
  my $pid = fork();
  if (!defined $pid) { close $c; next; }
  if ($pid) { close $c; next; }
  # child: one request, then exit
  close $srv;
  $c->autoflush(1);
  binmode $c;
  local $SIG{ALRM} = sub { exit 0 };
  alarm 20;
  my $req = <$c>;
  exit 0 unless defined $req;
  while (my $h = <$c>) { last if $h =~ /^\r?\n$/; }
  alarm 0;
  my ($method, $path) = $req =~ m{^(GET|HEAD)\s+(\S+)};
  unless ($method) { print $c "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"; exit 0; }
  $path =~ s/[?#].*//;
  $path =~ s/%([0-9A-Fa-f]{2})/chr(hex($1))/ge;
  $path = '/index.html' if $path eq '/';
  my $file = $root . $path;
  $file .= '/index.html' if -d $file;
  if ($path !~ m{\.\.} && -f $file && open(my $fh, '<:raw', $file)) {
    my $size = -s $fh;
    my ($ext) = $file =~ /\.([^.\/]+)$/;
    my $type = $mime{lc($ext // '')} // 'application/octet-stream';
    print $c "HTTP/1.1 200 OK\r\nContent-Type: $type\r\nContent-Length: $size\r\nCache-Control: no-cache\r\nConnection: close\r\n\r\n";
    if ($method eq 'GET') {
      my $buf;
      while (read($fh, $buf, 262144)) { print $c $buf or last; }
    }
    close $fh;
  } else {
    my $m = "not found: $path";
    print $c "HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nContent-Length: " . length($m) . "\r\nConnection: close\r\n\r\n$m";
  }
  close $c;
  exit 0;
}
