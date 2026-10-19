// The game's output (stdout/stderr of every thread) kept in memory, the last
// few megabytes of it, for "Download log" (the Mac app's ~/Library/Logs/NFSU2).
// Lines also go to the console, where test runners read them.

export class LogRing {
  private lines: string[] = [];
  private head = 0;
  private bytes = 0;
  dropped = 0;
  constructor(private budget = 8 << 20, private echo = true) {}

  add(s: string) {
    this.lines.push(s);
    this.bytes += s.length + 1;
    while (this.bytes > this.budget && this.head < this.lines.length) {
      this.bytes -= this.lines[this.head].length + 1; this.head++; this.dropped++;
    }
    if (this.head > 4096 && this.head * 2 > this.lines.length) { this.lines = this.lines.slice(this.head); this.head = 0; }
    if (this.echo) console.log(s);
  }
  /** the newest n lines */
  tail(n: number): string[] { return this.lines.slice(Math.max(this.head, this.lines.length - n)); }
  text(): string {
    const head = this.dropped ? `[... ${this.dropped} earlier lines dropped: the log keeps the last ${(this.budget / 1048576).toFixed(0)} MB]\n` : '';
    return head + this.lines.slice(this.head).join('\n') + '\n';
  }
  get size() { return this.bytes; }
  get count() { return this.lines.length - this.head; }
  clear() { this.lines = []; this.head = 0; this.bytes = 0; this.dropped = 0; }
}

export function downloadBlob(data: BlobPart, name: string, type = 'application/octet-stream') {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.style.display = 'none';
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

export function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
