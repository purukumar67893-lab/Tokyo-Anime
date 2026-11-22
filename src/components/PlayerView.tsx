import React, { useState, useEffect, useRef } from 'react';
import {
  Server,
  SkipBack,
  SkipForward,
  List,
  RefreshCw,
  Maximize2,
  Minimize2,
  ChevronLeft,
  AlertCircle,
  CheckCircle2,
} from 'lucide-react';
import { EpisodeDetails, VideoServer, ResolvedStream, AnimeDetails, AnimeEpisode } from '../types/anime';
import { api, storage } from '../services/api';
import { HlsVideoPlayer } from './HlsVideoPlayer';

interface PlayerViewProps {
  episodeSlugOrUrl: string;
  onBack: () => void;
  onSelectEpisode: (slugOrUrl: string) => void;
  onOpenSeries: (seriesSlugOrUrl: string) => void;
}

export const PlayerView: React.FC<PlayerViewProps> = ({
  episodeSlugOrUrl,
  onBack,
  onSelectEpisode,
  onOpenSeries,
}) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [episodeData, setEpisodeData] = useState<EpisodeDetails | null>(null);
  const [currentServerIndex, setCurrentServerIndex] = useState(0);
  const [resolvedStream, setResolvedStream] = useState<ResolvedStream | null>(null);
  const [loadingStream, setLoadingStream] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [theaterMode, setTheaterMode] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [seriesDetails, setSeriesDetails] = useState<AnimeDetails | null>(null);
  const [loadingSeries, setLoadingSeries] = useState(false);
  const autoFallbackTriedRef = useRef<Set<number>>(new Set());
  const topRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    topRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [episodeSlugOrUrl]);

  // Fetch episode details
  useEffect(() => {
    let isMounted = true;
    async function loadEpisode() {
      setLoading(true);
      setError(null);
      setResolvedStream(null);
      setStreamError(null);
      autoFallbackTriedRef.current = new Set();
      try {
        const data = await api.getEpisodeDetails(episodeSlugOrUrl);
        if (!isMounted) return;
        setEpisodeData(data);
        setCurrentServerIndex(0);

        // Record in watch history
        const episodeNum = data.title.match(/Episode\s+(\d+(\.\d+)?)/i)?.[1] || '';
        storage.addToHistory({
          animeSlug: data.series?.slug || '',
          animeTitle: data.series?.title || data.title.split('Episode')[0].trim(),
          poster: '',
          episodeNumber: episodeNum,
          episodeSlug: data.slug,
          episodeTitle: data.title,
        });

        // Load series episodes list in background for instant episode hopping
        if (data.series?.slug || data.series?.href) {
          setLoadingSeries(true);
          api
            .getAnimeDetails(data.series.slug || data.series.href)
            .then((s) => {
              if (isMounted) {
                setSeriesDetails(s);
                if (s.poster) {
                  storage.addToHistory({
                    animeSlug: s.slug,
                    animeTitle: s.title,
                    poster: s.poster,
                    episodeNumber: episodeNum,
                    episodeSlug: data.slug,
                    episodeTitle: data.title,
                  });
                }
              }
            })
            .catch(() => {})
            .finally(() => {
              if (isMounted) setLoadingSeries(false);
            });
        }
      } catch (err: any) {
        if (!isMounted) return;
        setError(err.message || 'Failed to load video episode');
      } finally {
        if (isMounted) setLoading(false);
      }
    }

    loadEpisode();
    return () => {
      isMounted = false;
    };
  }, [episodeSlugOrUrl]);

  // Resolve active server into direct ad-free & sandbox-free HLS stream
  const activeServerUrl =
    episodeData?.servers[currentServerIndex]?.url || episodeData?.currentEmbed || '';

  useEffect(() => {
    if (!activeServerUrl) {
      setResolvedStream(null);
      return;
    }

    let isMounted = true;
    setLoadingStream(true);
    setStreamError(null);

    api
      .resolveStream(activeServerUrl)
      .then((stream) => {
        if (!isMounted) return;
        setResolvedStream(stream);
        setLoadingStream(false);
      })
      .catch((err: any) => {
        if (!isMounted) return;
        // Automatic failover to next server if available and not yet tried
        const totalServers = episodeData?.servers.length || 0;
        autoFallbackTriedRef.current.add(currentServerIndex);
        if (totalServers > 1) {
          const nextIdx = (currentServerIndex + 1) % totalServers;
          if (!autoFallbackTriedRef.current.has(nextIdx)) {
            setCurrentServerIndex(nextIdx);
            return;
          }
        }
        setResolvedStream(null);
        setStreamError(err.message || 'Unable to load stream from this server.');
        setLoadingStream(false);
      });

    return () => {
      isMounted = false;
    };
  }, [activeServerUrl, reloadKey, episodeData, currentServerIndex]);

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh] gap-4">
        <div className="h-10 w-10 animate-spin rounded-full border-2 border-rose-500 border-t-transparent" />
        <span className="text-sm font-medium text-slate-400">Loading episode...</span>
      </div>
    );
  }

  if (error || !episodeData) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[50vh] p-8 text-center bg-slate-900/40 rounded-xl border border-slate-800">
        <AlertCircle className="w-12 h-12 text-rose-500 mb-3" />
        <h2 className="text-lg font-bold text-white mb-2">Failed to load video stream</h2>
        <p className="text-sm text-slate-400 max-w-md mb-6">{error || 'Server stream unavailable'}</p>
        <div className="flex gap-3">
          <button
            onClick={onBack}
            className="px-4 py-2 text-sm font-medium rounded-lg border border-slate-700 text-slate-300 hover:bg-slate-800"
          >
            Go Back
          </button>
          <button
            onClick={() => setReloadKey((k) => k + 1)}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-rose-600 text-white hover:bg-rose-500"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  const currentServer: VideoServer | undefined =
    episodeData.servers[currentServerIndex] ||
    (episodeData.currentEmbed ? { name: 'Omega Server', url: episodeData.currentEmbed } : undefined);

  const handlePlayerFatalError = () => {
    const totalServers = episodeData.servers.length;
    if (totalServers > 1) {
      const nextIdx = (currentServerIndex + 1) % totalServers;
      if (!autoFallbackTriedRef.current.has(nextIdx)) {
        autoFallbackTriedRef.current.add(currentServerIndex);
        setCurrentServerIndex(nextIdx);
      }
    }
  };

  return (
    <div ref={topRef} className={`flex flex-col gap-6 ${theaterMode ? 'max-w-full' : 'max-w-7xl'} mx-auto w-full transition-all duration-300`}>
      {/* Top Bar Navigation */}
      <div className="flex items-center justify-between gap-4">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs font-semibold text-slate-400 hover:text-white transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          <span>Back to Browse</span>
        </button>

        <div className="flex items-center gap-2">
          {episodeData.series && (
            <button
              onClick={() => onOpenSeries(episodeData.series?.slug || episodeData.series?.href || '')}
              className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-white transition-colors"
            >
              <List className="w-3.5 h-3.5 text-rose-400" />
              <span>Series Episodes</span>
            </button>
          )}

          <button
            onClick={() => setTheaterMode(!theaterMode)}
            className="hidden sm:flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-700 hover:text-white transition-colors"
            title={theaterMode ? 'Default View' : 'Theater View'}
          >
            {theaterMode ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
            <span>{theaterMode ? 'Standard' : 'Theater'}</span>
          </button>
        </div>
      </div>

      {/* Main Video Frame & Sidebar Container */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left Column: Ad-Free Native HLS Player & Controls */}
        <div className={theaterMode ? 'lg:col-span-12' : 'lg:col-span-8 xl:col-span-9'}>
          {/* 16:9 Responsive Video Viewport (100% ad-free & sandbox-free) */}
          <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black border border-slate-800 shadow-2xl">
            {loadingStream ? (
              <div className="flex h-full w-full flex-col items-center justify-center gap-3 text-slate-400">
                <div className="h-9 w-9 animate-spin rounded-full border-2 border-rose-500 border-t-transparent" />
                <span className="text-xs font-medium">
                  Connecting ad-free {currentServer?.name || 'video stream'}...
                </span>
              </div>
            ) : resolvedStream?.type === 'hls' && resolvedStream.hlsUrl ? (
              <HlsVideoPlayer
                key={`${resolvedStream.hlsUrl}-${reloadKey}`}
                hlsUrl={resolvedStream.hlsUrl}
                tracks={resolvedStream.tracks}
                intro={resolvedStream.intro}
                outro={resolvedStream.outro}
                poster={resolvedStream.poster}
                onFatalError={handlePlayerFatalError}
              />
            ) : resolvedStream?.type === 'iframe' && resolvedStream.iframeUrl ? (
              <iframe
                key={`${resolvedStream.iframeUrl}-${reloadKey}`}
                src={resolvedStream.iframeUrl}
                title={episodeData.title}
                allowFullScreen
                scrolling="no"
                className="h-full w-full border-0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share; fullscreen"
              />
            ) : (
              <div className="flex h-full w-full flex-col items-center justify-center p-6 text-center text-slate-400">
                <AlertCircle className="w-10 h-10 text-rose-500 mb-2" />
                <p className="text-sm font-medium text-slate-300">
                  {streamError || 'Video stream unavailable'}
                </p>
                <button
                  onClick={() => setReloadKey((k) => k + 1)}
                  className="mt-3 px-4 py-1.5 rounded-lg bg-rose-600 text-xs font-semibold text-white hover:bg-rose-500 transition-colors"
                >
                  Retry Stream
                </button>
              </div>
            )}
          </div>

          {/* Dedicated 2-Server Switcher: Omega Server & Moon Server (Ad-Free) */}
          <div className="mt-4 p-4 rounded-xl border border-slate-800/80 bg-slate-900/50">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex flex-wrap items-center gap-2.5">
                <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300 mr-1">
                  <Server className="w-4 h-4 text-rose-500" />
                  <span>Servers:</span>
                </div>

                {episodeData.servers.map((server, idx) => {
                  const isActive = idx === currentServerIndex;
                  const isOmega = server.name.toLowerCase().includes('omega');

                  return (
                    <button
                      key={`${server.name}-${idx}`}
                      onClick={() => {
                        autoFallbackTriedRef.current.add(idx);
                        setCurrentServerIndex(idx);
                        setReloadKey((k) => k + 1);
                      }}
                      className={`flex items-center gap-2 px-4 py-2 rounded-lg text-xs font-semibold transition-all ${
                        isActive
                          ? isOmega
                            ? 'bg-amber-500 text-black shadow-md shadow-amber-500/25'
                            : 'bg-indigo-500 text-white shadow-md shadow-indigo-500/25'
                          : 'bg-slate-800/80 text-slate-200 border border-slate-700 hover:bg-slate-700 hover:text-white'
                      }`}
                    >
                      <span>{server.name}</span>
                      {isActive && <CheckCircle2 className="w-3.5 h-3.5" />}
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => setReloadKey((k) => k + 1)}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-800 bg-slate-900 text-xs font-medium text-slate-300 hover:bg-slate-800 hover:text-white transition-colors"
                title="Reload current server"
              >
                <RefreshCw className="w-3.5 h-3.5" />
                <span>Reload</span>
              </button>
            </div>
          </div>

          {/* Episode Title & Playback Controls Bar */}
          <div className="mt-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 rounded-xl border border-slate-800/80 bg-slate-900/60">
            <div className="flex flex-col">
              <h1 className="text-lg sm:text-xl font-bold text-white tracking-tight">
                {episodeData.title}
              </h1>
              {episodeData.series?.title && (
                <div className="mt-1 flex items-center gap-2 text-xs text-slate-400">
                  <span className="text-rose-400 font-medium">{episodeData.series.title}</span>
                  {currentServer?.name && (
                    <>
                      <span aria-hidden="true">·</span>
                      <span>{currentServer.name}</span>
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Navigation buttons: Prev / Next */}
            <div className="flex items-center gap-2 shrink-0">
              <button
                disabled={!episodeData.prevEpisode}
                onClick={() =>
                  episodeData.prevEpisode &&
                  onSelectEpisode(episodeData.prevEpisode.slug || episodeData.prevEpisode.href)
                }
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold transition-all ${
                  episodeData.prevEpisode
                    ? 'border-slate-700 bg-slate-800 text-slate-200 hover:bg-slate-700 hover:text-white'
                    : 'border-slate-800/40 bg-slate-900/40 text-slate-600 cursor-not-allowed'
                }`}
              >
                <SkipBack className="w-3.5 h-3.5" />
                <span>Prev Episode</span>
              </button>

              <button
                disabled={!episodeData.nextEpisode}
                onClick={() =>
                  episodeData.nextEpisode &&
                  onSelectEpisode(episodeData.nextEpisode.slug || episodeData.nextEpisode.href)
                }
                className={`flex items-center gap-1.5 px-3 py-2 rounded-lg border text-xs font-semibold transition-all ${
                  episodeData.nextEpisode
                    ? 'border-rose-600 bg-rose-600 text-white shadow-md shadow-rose-600/30 hover:bg-rose-500'
                    : 'border-slate-800/40 bg-slate-900/40 text-slate-600 cursor-not-allowed'
                }`}
              >
                <span>Next Episode</span>
                <SkipForward className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>

        {/* Right Column: Series Episodes List & Quick Hopping */}
        <div className={theaterMode ? 'lg:col-span-12' : 'lg:col-span-4 xl:col-span-3'}>
          <div className="rounded-xl border border-slate-800/80 bg-slate-900/50 p-4">
            <div className="flex items-center justify-between pb-3 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <List className="w-4 h-4 text-rose-500" />
                <h2 className="text-sm font-bold text-white">Episodes List</h2>
              </div>
              {seriesDetails && (
                <span className="text-xs font-mono text-slate-400 tabular-nums">
                  {seriesDetails.episodes.length} Total
                </span>
              )}
            </div>

            {loadingSeries ? (
              <div className="py-12 flex flex-col items-center justify-center gap-2">
                <div className="h-6 w-6 animate-spin rounded-full border border-rose-500 border-t-transparent" />
                <span className="text-xs text-slate-500">Loading series list...</span>
              </div>
            ) : seriesDetails && seriesDetails.episodes.length > 0 ? (
              <div className="mt-3 max-h-[500px] overflow-y-auto pr-1 flex flex-col gap-1.5">
                {seriesDetails.episodes.map((ep: AnimeEpisode) => {
                  const isCurrent =
                    ep.slug === episodeData.slug ||
                    ep.href === episodeData.href ||
                    episodeSlugOrUrl.includes(ep.slug);

                  return (
                    <button
                      key={ep.slug || ep.number}
                      onClick={() => onSelectEpisode(ep.slug || ep.href)}
                      className={`flex items-center justify-between p-2.5 rounded-lg text-left text-xs transition-all ${
                        isCurrent
                          ? 'bg-rose-600/15 border border-rose-500/50 text-rose-300 font-semibold'
                          : 'hover:bg-slate-800/60 text-slate-300 border border-transparent'
                      }`}
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="flex-shrink-0 w-8 font-mono tabular-nums text-slate-400">
                          #{ep.number}
                        </span>
                        <span className="truncate">{ep.title}</span>
                      </div>
                      {isCurrent ? (
                        <span className="text-[10px] text-rose-400 font-semibold uppercase tracking-wider shrink-0 ml-2">
                          Playing
                        </span>
                      ) : (
                        ep.sub && (
                          <span className="text-[10px] text-slate-500 shrink-0 ml-2">
                            {ep.sub}
                          </span>
                        )
                      )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="py-8 text-center text-xs text-slate-500">
                <span>Navigate using Prev/Next buttons above</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
