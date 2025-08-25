# Nodejs Sherpa-Onnx Subtitle Generator & Translator

![Screenshot_20250825_181855_com kiwibrowser browser](https://github.com/user-attachments/assets/f4711c6c-5286-4d8b-bb08-b62b340b2fc9)

Generate and translate subtitles using Sherpa-Onnx node-addon-api that are 2 to 3 times faster than using python and translate subtitle using Google Translate.

## Features

### Subtitle Generator (gensrt-cli.js)
- generate subtitle with commandline Uses Sherpa-ONNX SenseVoice model for accurate speech recognition in multiple languages (Chinese, English, Japanese, Korean, Cantonese) or Zipformer model for Japanese, or NeMo CTC model for 10 European languages (Belarusian, German, English, Spanish, French, Croatian, Italian, Polish, Russian, Ukrainian)
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

##

## Usage

### Generating Subtitles with CLI Script

Export LD_LIBRARY_PATH based on your architecture, for example:

```bash
export LD_LIBRARY_PATH=$PWD/node_modules/sherpa-onnx-linux-arm64:$LD_LIBRARY_PATH
```
for use with commandline

```bash
node gensrt-cli.js /path/to/media/folder --model <modelName>
```
Example usage:
```bash
node gensrt-cli.js /path/to/media/folder --model senseVoice
```
```bash
node gensrt-cli.js /path/to/media/folder --model nemoCtc
```

```bash
node gensrt-cli.js /path/to/media/folder --model transducer
```

The CLI script provides progress bars and real-time feedback during the transcription process.

### Translating Subtitles with SRT Translator

To translate existing SRT files in a directory to another language:
```bash
node srt-gtk.js /path/to/srt/folder sourceLanguage targetLanguage
```

Example - support auto detect language of srt, or specify language of srt used.
```bash
node srt-gtk.js /path/to/srt/folder auto zh
```

```bash
node srt-gtk.js /path/to/srt/folder en zh
```

The script will create new SRT files with `-targetLanguage` suffix (e.g., `movie-zh.srt`) under same folder.

### Using the Web Interface

Start the server:
```bash
node --expose-gc server.js
```

Access the web interface at `http://localhost:3000` to manage transcription and translation

