import { spawn } from 'child_process';
import { NextResponse } from 'next/server';

const videoFormats = ['mp4', 'webm', 'mkv', 'flv', 'avi', 'mov', '3gp', 'ogv'];
const audioFormats = ['mp3', 'm4a', 'wav', 'aac', 'flac', 'opus', 'vorbis'];

export async function POST(req) {
  const { url, format } = await req.json();

  if (!url || !format || !url.startsWith('http')) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  }

  let args = [];
  if (videoFormats.includes(format)) {
    args = ['--recode-video', format, '-o', '-', url];
  } else if (audioFormats.includes(format)) {
    args = ['-x', '--audio-format', format, '-o', '-', url];
  } else {
    return NextResponse.json({ error: 'Unsupported format' }, { status: 400 });
  }

  const child = spawn('yt-dlp', args);

  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  child.on('exit', (code) => {
    if (code !== 0) {
      console.error('yt-dlp failed:', stderr);
    }
  });

  const contentType = videoFormats.includes(format)
    ? 'video/' + (format === 'mkv' ? 'x-matroska' : format)
    : 'audio/' + (format === 'm4a' ? 'mp4' : format);

  return new Response(child.stdout, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="facebook.${format}"`,
    },
  });
}
