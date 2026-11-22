import React, { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import { Subtitles, Settings, FastForward, AlertCircle } from 'lucide-react';
import { SubtitleTrack } from '../types/anime';

interface HlsVideoPlayerProps {
  hlsUrl: string;
  tracks?: SubtitleTrack[];
  intro?: { start: number; end: number } | null;
  outro?: { start: number; end: number } | null;
  poster?: string;
  onFatalError?: () => void;
}

interface QualityLevel {
  index: number;
  label: string;
}

export const HlsVideoPlayer: React.FC<HlsVideoPlayerProps> = ({
  hlsUrl,
  tracks = [],
  intro,
  outro,
  poster,
  onFatalError,
}) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [levels, setLevels] = useState<QualityLevel[]>([]);
  const [currentLevel, setCurrentLevel] = useState<number>(-1);
  const [selectedSubtitle, setSelectedSubtitle] = useState<number>(-1);
  const [currentTime, setCurrentTime] = useState(0);
  const [isBuffering, setIsBuffering] = useState(true);
  const [playbackError, setPlaybackError] = useState<string | null>(null);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [showSubMenu, setShowSubMenu] = useState(false);

  const captionTracks = tracks.filter(
    (t) => t.file && t.kind !== 'thumbnails' && !t.file.includes('sprite')
  );

  // Pick default English subtitle if available
  useEffect(() => {
    if (captionTracks.length === 0) {
      setSelectedSubtitle(-1);
      return;
    }
    const defaultIdx = captionTracks.findIndex(
      (t) => t.default || t.label.toLowerCase().includes('english')
    );
    setSelectedSubtitle(defaultIdx >= 0 ? defaultIdx : 0);
  }, [hlsUrl, tracks.length]);

  // Attach HLS stream to native HTML5 <video> (100% ad-free & sandbox-free)
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hlsUrl) return;

    setIsBuffering(true);
    setPlaybackError(null);
    setLevels([]);
    setCurrentLevel(-1);

    let hls: Hls | null = null;
    let networkRetries = 0;

    if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        startLevel: -1,
      });
      hlsRef.current = hls;

      hls.loadSource(hlsUrl);
      hls.attachMedia(video);

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        setIsBuffering(false);
        const parsedLevels: QualityLevel[] = data.levels
          .map((lvl, idx) => ({
            index: idx,
            label: lvl.height ? `${lvl.height}p` : `Level ${idx + 1}`,
          }))
          .sort((a, b) => {
            const ah = parseInt(a.label, 10) || 0;
            const bh = parseInt(b.label, 10) || 0;
            return bh - ah;
          });
        setLevels(parsedLevels);
        video.play().catch(() => {
          // Autoplay blocked by browser policy; user can press play
        });
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (!data.fatal) return;
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 2) {
          networkRetries += 1;
          hls?.startLoad();
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls?.recoverMediaError();
        } else {
          setIsBuffering(false);
          setPlaybackError('Stream interrupted. Try switching servers or reloading.');
          onFatalError?.();
        }
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari / iOS native HLS support
      video.src = hlsUrl;
      const onLoaded = () => {
        setIsBuffering(false);
        video.play().catch(() => {});
      };
      const onErr = () => {
        setIsBuffering(false);
        setPlaybackError('Unable to load HLS stream.');
        onFatalError?.();
      };
      video.addEventListener('loadedmetadata', onLoaded);
      video.addEventListener('error', onErr);
      return () => {
        video.removeEventListener('loadedmetadata', onLoaded);
        video.removeEventListener('error', onErr);
      };
    } else {
      setPlaybackError('HLS playback is not supported in this browser.');
    }

    return () => {
      if (hls) {
        hls.destroy();
      }
      hlsRef.current = null;
    };
  }, [hlsUrl]);

  // Sync active subtitle track with <video> textTracks
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const textTracks = video.textTracks;
    for (let i = 0; i < textTracks.length; i++) {
      textTracks[i].mode = i === selectedSubtitle ? 'showing' : 'disabled';
    }
  }, [selectedSubtitle, hlsUrl, captionTracks.length]);

  const handleQualityChange = (levelIdx: number) => {
    setCurrentLevel(levelIdx);
    setShowQualityMenu(false);
    if (hlsRef.current) {
      hlsRef.current.currentLevel = levelIdx;
    }
  };

  const inIntro =
    intro &&
    intro.end > intro.start &&
    currentTime >= intro.start &&
    currentTime < intro.end - 1;

  const inOutro =
    outro &&
    outro.end > outro.start &&
    currentTime >= outro.start &&
    currentTime < outro.end - 1;

  const activeQualityLabel =
    currentLevel === -1
      ? 'Auto'
      : levels.find((l) => l.index === currentLevel)?.label || 'Auto';

  return (
    <div className="relative h-full w-full bg-black select-none group">
      <video
        ref={videoRef}
        controls
        playsInline
        crossOrigin="anonymous"
        poster={poster}
        onWaiting={() => setIsBuffering(true)}
        onPlaying={() => setIsBuffering(false)}
        onCanPlay={() => setIsBuffering(false)}
        onTimeUpdate={(e) => setCurrentTime(e.currentTarget.currentTime)}
        className="h-full w-full bg-black object-contain"
      >
        {captionTracks.map((track, idx) => (
          <track
            key={`${track.file}-${idx}`}
            kind="subtitles"
            src={track.file}
            label={track.label || `Subtitle ${idx + 1}`}
            default={idx === selectedSubtitle}
          />
        ))}
      </video>

      {/* Buffering spinner */}
      {isBuffering && !playbackError && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/40">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-rose-500 border-t-transparent" />
        </div>
      )}

      {/* Playback error overlay */}
      {playbackError && (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/80 p-6 text-center">
          <AlertCircle className="w-10 h-10 text-rose-500 mb-2" />
          <p className="text-sm font-medium text-slate-200">{playbackError}</p>
        </div>
      )}

      {/* Top-right Quality & Subtitle Controls */}
      <div className="absolute top-3 right-3 z-20 flex items-center gap-2 opacity-90 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        {captionTracks.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowSubMenu((v) => !v);
                setShowQualityMenu(false);
              }}
              className="flex items-center gap-1.5 rounded-lg bg-black/75 border border-white/15 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/90"
              title="Subtitles"
            >
              <Subtitles className="w-3.5 h-3.5 text-rose-400" />
              <span>{selectedSubtitle >= 0 ? 'CC On' : 'CC Off'}</span>
            </button>

            {showSubMenu && (
              <div className="absolute right-0 mt-1.5 w-44 max-h-56 overflow-y-auto rounded-lg border border-slate-700 bg-slate-950/95 p-1 shadow-xl backdrop-blur-md">
                <button
                  type="button"
                  onClick={() => {
                    setSelectedSubtitle(-1);
                    setShowSubMenu(false);
                  }}
                  className={`w-full rounded px-2.5 py-1.5 text-left text-xs ${
                    selectedSubtitle === -1
                      ? 'bg-rose-600 text-white font-semibold'
                      : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  Off
                </button>
                {captionTracks.map((t, idx) => (
                  <button
                    key={`${t.label}-${idx}`}
                    type="button"
                    onClick={() => {
                      setSelectedSubtitle(idx);
                      setShowSubMenu(false);
                    }}
                    className={`w-full truncate rounded px-2.5 py-1.5 text-left text-xs ${
                      selectedSubtitle === idx
                        ? 'bg-rose-600 text-white font-semibold'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {levels.length > 0 && (
          <div className="relative">
            <button
              type="button"
              onClick={() => {
                setShowQualityMenu((v) => !v);
                setShowSubMenu(false);
              }}
              className="flex items-center gap-1.5 rounded-lg bg-black/75 border border-white/15 px-2.5 py-1.5 text-xs font-medium text-white backdrop-blur-sm hover:bg-black/90"
              title="Video Quality"
            >
              <Settings className="w-3.5 h-3.5 text-rose-400" />
              <span>{activeQualityLabel}</span>
            </button>

            {showQualityMenu && (
              <div className="absolute right-0 mt-1.5 w-32 rounded-lg border border-slate-700 bg-slate-950/95 p-1 shadow-xl backdrop-blur-md">
                <button
                  type="button"
                  onClick={() => handleQualityChange(-1)}
                  className={`w-full rounded px-2.5 py-1.5 text-left text-xs ${
                    currentLevel === -1
                      ? 'bg-rose-600 text-white font-semibold'
                      : 'text-slate-300 hover:bg-slate-800'
                  }`}
                >
                  Auto
                </button>
                {levels.map((lvl) => (
                  <button
                    key={lvl.index}
                    type="button"
                    onClick={() => handleQualityChange(lvl.index)}
                    className={`w-full rounded px-2.5 py-1.5 text-left text-xs ${
                      currentLevel === lvl.index
                        ? 'bg-rose-600 text-white font-semibold'
                        : 'text-slate-300 hover:bg-slate-800'
                    }`}
                  >
                    {lvl.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Skip Intro / Skip Outro button */}
      {(inIntro || inOutro) && (
        <button
          type="button"
          onClick={() => {
            if (videoRef.current) {
              videoRef.current.currentTime = inIntro ? intro!.end : outro!.end;
            }
          }}
          className="absolute bottom-14 right-4 z-20 flex items-center gap-1.5 rounded-lg bg-rose-600 px-3.5 py-2 text-xs font-semibold text-white shadow-lg shadow-rose-600/30 hover:bg-rose-500 transition-all"
        >
          <FastForward className="w-3.5 h-3.5" />
          <span>{inIntro ? 'Skip Intro' : 'Skip Outro'}</span>
        </button>
      )}
    </div>
  );
};
