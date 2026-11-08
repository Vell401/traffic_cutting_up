export interface RadioTrack { id: string; title: string; bytes: number; type: string }
export interface RadioPlaylist { id: string; name: string; tracks: RadioTrack[] }
export interface RadioLibrary { playlists: RadioPlaylist[] }
export const RADIO_MAX_TRACK_BYTES = 40 * 1024 * 1024;
