/**
 * Enum for external file/folder sources
 * Used to identify which cloud storage provider a file or folder comes from
 */
export enum ExternalSource {
  ONEDRIVE = 'onedrive',
  GOOGLE_DRIVE = 'google-drive',
  DROPBOX = 'dropbox',
}

/**
 * Type guard to check if a string is a valid ExternalSource
 */
export function isValidExternalSource(source: string): source is ExternalSource {
  return Object.values(ExternalSource).includes(source as ExternalSource);
}

/**
 * Get the display name for an external source
 */
export function getExternalSourceDisplayName(source: ExternalSource): string {
  switch (source) {
    case ExternalSource.ONEDRIVE:
      return 'OneDrive';
    case ExternalSource.GOOGLE_DRIVE:
      return 'Google Drive';
    case ExternalSource.DROPBOX:
      return 'Dropbox';
    default:
      return 'Unknown';
  }
}
