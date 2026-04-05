import { spawn } from 'child_process';
import { NextResponse, after } from 'next/server';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import os from 'os';

const videoFormats = ['mp4', 'webm', 'mkv', 'flv', 'avi', 'mov', '3gp', 'ogv'];
const audioFormats = ['mp3', 'm4a', 'wav', 'aac', 'flac', 'opus', 'vorbis'];

export async function POST(req) {
  let tempFile = null;
  try {
    const { url, format } = await req.json();

    if (!url || !format || !url.startsWith('http')) {
      return NextResponse.json({ error: 'Invalid input' }, { status: 400 });
    }

    let targetUrl = url;
    // Reddit metadata API is often blocked, appending .json can bypass it
    if (targetUrl.includes('reddit.com/r/') && !targetUrl.endsWith('.json')) {
      targetUrl = targetUrl.split('?')[0].replace(/\/$/, '') + '/.json';
    }

    // Use a unique temp file because many formats (avi, mov, mp4) cannot be streamed to stdout
    const tempId = uuidv4();
    const tempDir = os.tmpdir();
    tempFile = path.join(tempDir, `${tempId}.${format}`);
    
    console.log(`[api/download] Target: ${format} | URL: ${targetUrl} | Temp: ${tempFile}`);

    // Impersonate Chrome to bypass Cloudflare and other anti-bot measures
    let args = [
      '--impersonate', 'chrome:windows',
      '--no-check-certificates',
      '--no-warnings',
      '--socket-timeout', '30',
      '--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com',
      '-o', tempFile
    ];

    if (videoFormats.includes(format)) {
      args.push('--recode-video', format);
    } else if (audioFormats.includes(format)) {
      args.push('-x', '--audio-format', format);
    } else {
      return NextResponse.json({ error: 'Unsupported format' }, { status: 400 });
    }

    args.push(targetUrl);

    await new Promise((resolve, reject) => {
      const child = spawn('yt-dlp', args);
      let stderr = '';
      child.stderr.on('data', (d) => stderr += d.toString());
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`yt-dlp failed (${code}): ${stderr}`));
      });
    });

    if (!fs.existsSync(tempFile)) {
      throw new Error('yt-dlp finished but output file is missing.');
    }

    const stats = fs.statSync(tempFile);
    const fileStream = fs.createReadStream(tempFile);

    const mimeMap = {
      mp4: 'video/mp4', webm: 'video/webm', mkv: 'video/x-matroska',
      flv: 'video/x-flv', avi: 'video/x-msvideo', mov: 'video/quicktime',
      '3gp': 'video/3gpp', ogv: 'video/ogg',
      mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac',
      opus: 'audio/opus', wav: 'audio/wav', flac: 'audio/flac',
    };

    const response = new NextResponse(fileStream, {
      headers: {
        'Content-Type': mimeMap[format] || 'application/octet-stream',
        'Content-Disposition': `attachment; filename="download.${format}"`,
        'Content-Length': stats.size.toString(),
      },
    });

    // Cleanup temp file AFTER the response is fully sent using Next.js 15 after()
    const finalTempFile = tempFile;
    after(() => {
        if (fs.existsSync(finalTempFile)) {
            fs.unlink(finalTempFile, (err) => {
                if (err) console.error(`Failed to delete temp file ${finalTempFile}:`, err);
                else console.log(`[api/download] Deleted temp file: ${finalTempFile}`);
            });
        }
    });

    return response;

  } catch (err) {
    console.error('[api/download] Error:', err.message);
    if (tempFile && fs.existsSync(tempFile)) {
        try { fs.unlinkSync(tempFile); } catch {}
    }
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
