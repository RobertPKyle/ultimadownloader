import { spawn } from 'child_process';
import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { v4 as uuidv4 } from 'uuid';
import archiver from 'archiver';
import { pipeline } from 'stream/promises';

const videoFormats = ['mp4', 'webm', 'mkv', 'flv', 'avi', 'mov', '3gp', 'ogv'];
const audioFormats = ['mp3', 'm4a', 'wav', 'aac', 'flac', 'opus', 'vorbis'];

export async function POST(req) {
  const { url, format } = await req.json();

  if (!url || !format || !url.startsWith('http')) {
    return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
  }

  const tempDir = path.join(os.tmpdir(), uuidv4());
  fs.mkdirSync(tempDir);

  const outputTemplate = path.join(tempDir, '%(title)s.%(ext)s');
  const args = [url, '-o', outputTemplate];

  if (videoFormats.includes(format)) {
    args.unshift('--recode-video', format);
  } else if (audioFormats.includes(format)) {
    args.unshift('-x', '--audio-format', format);
  } else {
    return NextResponse.json({ error: 'Unsupported format' }, { status: 400 });
  }

  // Add yt-dlp options to download entire channel
  args.push('--yes-playlist');

  const child = spawn('yt-dlp', args);

  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += data.toString();
  });

  await new Promise((resolve, reject) => {
    child.on('close', (code) => {
      if (code !== 0) {
        console.error('yt-dlp failed:', stderr);
        reject(new Error('yt-dlp failed'));
      } else {
        resolve();
      }
    });
  });

  // ZIP everything
  const archive = archiver('zip');
  const zipPath = path.join(os.tmpdir(), `${uuidv4()}.zip`);
  const output = fs.createWriteStream(zipPath);

  archive.pipe(output);
  fs.readdirSync(tempDir).forEach((file) => {
    archive.file(path.join(tempDir, file), { name: file });
  });
  await archive.finalize();
  await new Promise((res) => output.on('close', res));

  const zipStream = fs.createReadStream(zipPath);

  return new Response(zipStream, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="channel.zip"`,
    },
  });
}
