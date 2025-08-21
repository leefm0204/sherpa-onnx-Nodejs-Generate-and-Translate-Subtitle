Generate and translate using Sherpa-Onnx node-addon-api and Google-translate.

1. `transcriber.js` - a 2 to 3x faster Nodejs scripts for generating subtitle compare to python code, & support parallel processing 
2. `srt-gtk.js` - Translates SRT subtitles using Free Google Translate
3. `server.js` - Web interface for managing transcription and translation tasks

## Features

### Transcriber (`transcriber.js`)
- Uses Sherpa-ONNX SenseVoice model for accurate speech recognition in multiple languages (Chinese, English, Japanese, Korean, Cantonese) or Zipformer model for Japanese
- Voice Activity Detection (VAD) to process only speech segments
- Progress tracking with speed metrics
- Automatic SRT file generation
- Memory-optimized processing with reduced buffer size (10 seconds)
- Efficient temporary file handling using /tmp directory
- Parallel processing support (up to 2 concurrent processes)
- Automatic skipping of files with existing SRT files
- Graceful shutdown handling with SIGKILL for cleanup

### SRT Translator (`srt-gtk.js`)
- Translates SRT subtitle files using Google's free translation endpoint
- Supports any language pairs supported by Google Translate
- Caches translations to avoid re-translating the same text
- Respects rate limits with configurable delays between requests
- Skips files that already have translations
- Graceful shutdown handling

### Web Interface (`server.js`)
- Real-time WebSocket communication for progress updates
- Web-based UI for managing transcription and translation tasks
- System information display (RAM/Swap usage)
- Process cancellation support
- File status tracking

### Memory Optimizations
- Reduced buffer size from 60 to 10 seconds to decrease RAM usage
- Limited maximum concurrency from 4 to 2 to reduce simultaneous processes
- Implemented disk-based buffering for SRT segment storage
- Used /tmp directory for temporary file storage
- Added explicit cleanup for segments arrays and ffmpeg processes to help with garbage collection
- Implemented forceful process termination using SIGKILL for better cleanup
- Fixed cross-device rename error by changing from rename to copy operation for temporary files
- Made skipping files with existing SRT files completely silent by default
- Removed progress messages and file counting that included skipped files
- Integrated tmp package for temporary file management

## Usage

### Generating Subtitles with Transcriber
Export LD_LIBRARY_PATH based on your architecture, for example:

```bash
export LD_LIBRARY_PATH=$PWD/node_modules/sherpa-onnx-linux-arm64:$LD_LIBRARY_PATH
```

To process all supported files in a directory:
```bash
node transcriber.js /path/to/media/folder
```

To process with a specific model:
```bash
node transcriber.js --model transducer /path/to/media/folder
```

To process with parallel execution (up to 2 concurrent processes):
```bash
node transcriber.js /path/to/media/folder 2
```

The script will create `.srt` files with the same base name as the input files in the same directory.

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
