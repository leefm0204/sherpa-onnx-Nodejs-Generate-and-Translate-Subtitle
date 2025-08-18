Generate and translate using Sherpa-Onnx node-addon-api and Google-translate.

1. `transcriber.js` - a 2 to 3x faster Nodejs scripts for generating subtitle compare to python code
2. `transcriber-parallel.js` - running transcriber process on multiples media files at the same time.
3. `srt-gtk.js` - Translates SRT subtitles using Free Google Translate

## Features

### Transcriber (`transcriber.js`)
- Uses Sherpa-ONNX SenseVoice model for accurate speech recognition in multiple languages (Chinese, English, Japanese, Korean, Cantonese)(may use other model)
- Voice Activity Detection (VAD) to process only speech segments
- Progress tracking with speed metrics
- Automatic SRT file generation

### SRT Translator (`srt-gtk.js`)
- Translates SRT subtitle files using Google's free translation endpoint
- Supports any language pairs supported by Google Translate
- Caches translations to avoid re-translating the same text
- Respects rate limits with configurable delays between requests
- Skips files that already have translations


### Generating Subtitles with Transcriber
export LD_LIBRARY_PATH based on your arch. for example

```bash
export LD_LIBRARY_PATH=$PWD/node_modules/sherpa-onnx-linux-arm64:$LD_LIBRARY_PATH
```

To process all supported files in a directory:
```bash
node transcriber.js /path/to/media/folder
```

The script will create `.srt` files with the same base name as the input files in the same directory.

### Translating Subtitles with SRT Translator

To translate existing SRT files in a directory to another language:
```bash
node srt-gtk.js /path/to/srt/folder sourceLanguage targetLanguage
```

Example - support auto detect language of srt, or specify language of srt used.
```
node srt-gtk.js ./subtitles auto ch
```
```bash
node srt-gtk.js ./subtitles en ch
```

The script will create new SRT files with `-targetLanguage` suffix (e.g., `movie-zh.srt`) under same folder.
