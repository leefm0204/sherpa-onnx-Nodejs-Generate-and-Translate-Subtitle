import path from "path";
import sherpa_onnx from "sherpa-onnx-node";

const MODELS = {
  senseVoice: {
    modelDir: "./sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
    createRecognizer: (cfg) => {
      return new sherpa_onnx.OfflineRecognizer({
        featConfig: { sampleRate: cfg.sampleRate, featureDim: cfg.featDim },
        modelConfig: {
          senseVoice: {
            model: path.join(cfg.modelDir, "model.int8.onnx"),
            useInverseTextNormalization: 1,
          },
          tokens: path.join(cfg.modelDir, "tokens.txt"),
          numThreads: 2, // Reduced from 4 to 2 threads to decrease CPU usage
          provider: "cpu",
          debug: false,
        },
      });
    },
  },

  nemoCtc: {
    modelDir: "./sherpa-onnx-nemo-fast-conformer-transducer-be-de-en-es-fr-hr-it-pl-ru-uk-20k",
    createRecognizer: (cfg) => {
      return new sherpa_onnx.OfflineRecognizer({
        featConfig: { sampleRate: cfg.sampleRate, featureDim: cfg.featDim },
        modelConfig: {
          nemoCtc: {
            model: path.join(cfg.modelDir, "model.onnx"),
            useInverseTextNormalization: 1,
          },
          tokens: path.join(cfg.modelDir, "tokens.txt"),
          numThreads: 2, // Reduced from 4 to 2 threads to decrease CPU usage
          provider: "cpu",
          debug: false,
        },
      });
    },
  },

  transducer: {
    modelDir: "./sherpa-onnx-zipformer-ja-reazonspeech-2024-08-01",
    createRecognizer: (cfg) => {
      return new sherpa_onnx.OfflineRecognizer({
        featConfig: { sampleRate: cfg.sampleRate, featureDim: cfg.featDim },
        modelConfig: {
          transducer: {
            encoder:  path.join(cfg.modelDir, "encoder-epoch-99-avg-1.int8.onnx"),
            decoder:  path.join(cfg.modelDir, "decoder-epoch-99-avg-1.int8.onnx"),
            joiner:   path.join(cfg.modelDir, "joiner-epoch-99-avg-1.int8.onnx"),
            useInverseTextNormalization: 1,
          },
          tokens: path.join(cfg.modelDir, "tokens.txt"),
          numThreads: 2, // Reduced from 4 to 2 threads to decrease CPU usage
          provider: "cpu",
          debug: false,
        },
      });
    },
  },
};

export function getModel(modelName) {
  const m = MODELS[modelName];
  if (!m) {
    const avail = Object.keys(MODELS).join(", ");
    throw new Error(`Un
known model "${modelName}". Available: ${avail}`);
  }
  return m;
}
