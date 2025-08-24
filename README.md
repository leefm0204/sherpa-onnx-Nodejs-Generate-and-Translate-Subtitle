# Sherpa-Onnx Subtitle Generator & Translator

Generate and translate subtitles using Sherpa-Onnx node-addon-api and Google Translate.

## Overview

This project provides a complete solution for generating and translating subtitles from audio/video files. It uses the high-performance Sherpa-Onnx engine for speech recognition and Google Translate for subtitle translation, with both web interface and command-line tools.

## Core Components

1. `gensrt-cli.js` - Command-line interface for generating subtitles with support for multiple models:
   - SenseVoice: Chinese, English, Japanese, Korean, Cantonese
   - Zipformer: Japanese
   - NeMo CTC: 10 European languages (Belarusian, German, English, Spanish, French, Croatian, Italian, Polish, Russian, Ukrainian)
2. `srt-gtk.js` - Translates SRT subtitles using free Google Translate
3. `server.js` - Web interface for managing transcription and translation tasks
4. `fileupload.js` - Handles file uploads with original names and automatic cleanup

## Features

### Subtitle Generator (`gensrt.js`)
- Uses Sherpa-ONNX SenseVoice model for accurate speech recognition in multiple languages (Chinese, English, Japanese, Korean, Cantonese) or Zipformer model for Japanese, or NeMo CTC model for 10 European languages (Belarusian, German, English, Spanish, French, Croatian, Italian, Polish, Russian, Ukrainian)
- Voice Activity Detection (VAD) to process only speech segments
- Progress tracking with speed metrics
- Automatic SRT file generation
- Memory-optimized processing with reduced buffer size (30 seconds)
- Efficient temporary file handling
- Automatic skipping of files with existing SRT files
- Graceful shutdown handling

### SRT Translator (`srt-gtk.js`)
- Translates SRT subtitle files using Google's free translation endpoint
- Supports any language pairs supported by Google Translate
- Caches translations to avoid re-translating the same text
- Respects rate limits with configurable delays between requests
- Skips files that already have translations
- Graceful shutdown handling

### Web Interface (`server.js`)
- Real-time WebSocket communication for progress updates
- Modern responsive web interface with dark theme
- Web-based UI for managing transcription and translation tasks
- System information display (RAM/Swap usage)
- Process cancellation support
- File status tracking
- Direct path processing and file upload capabilities
- Parallel processing with configurable concurrency

##

## Usage

### Generating Subtitles with CLI Script

Export LD_LIBRARY_PATH based on your architecture, for example:

```bash
export LD_LIBRARY_PATH=$PWD/node_modules/sherpa-onnx-linux-arm64:$LD_LIBRARY_PATH
```

For a more convenient command-line interface, you can use the `gensrt-cli.js` script directly or through npm:

```bash
# Direct usage
node gensrt-cli.js /path/to/media --model <modelName>

# Or using npm script
npm run cli /path/to/media -- --model <modelName>
```

Example usage:
```bash
node gensrt-cli.js /path/to/media --model senseVoice
node gensrt-cli.js /path/to/media --model transducer
node gensrt-cli.js /path/to/media --model nemoCtc

# Or using npm scripts
npm run cli /path/to/media -- --model senseVoice
npm run cli /path/to/media -- --model transducer
npm run cli /path/to/media -- --model nemoCtc
```

The CLI script provides progress bars and real-time feedback during the transcription process.

### Translating Subtitles with SRT Translator

To translate existing SRT files in a directory to another language:
```bash
node srt-gtk.js /path/to/srt/folder sourceLanguage targetLanguage
```

Example - support auto detect language of srt, or specify language of srt used.
```bash
node srt-gtk.js ./subtitles auto zh
```
```bash
node srt-gtk.js ./subtitles en zh
```

The script will create new SRT files with `-targetLanguage` suffix (e.g., `movie-zh.srt`) under same folder.

### Using the Web Interface

Start the server:
```bash
node server.js
```

Access the web interface at `http://localhost:3000` to manage transcription and translation tasks.

## System Requirements

- Node.js 14.0 or higher
- FFmpeg and FFprobe (automatically installed via npm dependencies)
- Sherpa-Onnx models (automatically downloaded)
