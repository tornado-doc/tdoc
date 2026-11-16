// Folder names are unique among siblings; the server decides (worker.js
// folderTwin). Create answers the existing folder (`existed`), rename to a
// taken name answers 409 duplicate_name with a sentence to show.

// A rename refused because a sibling already has the name.
export function isFolderNameClash(error) {
  return !!error && error.status === 409 && !!error.body && error.body.error === 'duplicate_name';
}

// Create may hand back a folder already in the list (it existed, or a second
// click raced the first): list it once.
export function addFolderOnce(list, folder) {
  if (!folder || list.some((item) => item.id === folder.id)) return list;
  return [...list, { ...folder, parent: folder.parent || '' }];
}
