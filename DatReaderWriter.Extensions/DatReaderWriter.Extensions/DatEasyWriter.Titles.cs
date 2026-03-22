using DatReaderWriter.DBObjs;
using DatReaderWriter.Extensions.DBObjs;
using DatReaderWriter.Lib;
using DatReaderWriter.Types;

namespace DatReaderWriter.Extensions {
    public partial class DatEasyWriter {
        /// <summary>
        /// Generates an enum ID from a title string.
        /// </summary>
        /// <param name="titleString">The title string (e.g. "My New Title")</param>
        /// <returns>The generated enum ID (e.g. "ID_CharacterTitle_MyNewTitle")</returns>
        private static string GenerateEnumId(string titleString) {
            // Remove spaces and concatenate words to form PascalCase
            var words = titleString.Split(' ', StringSplitOptions.RemoveEmptyEntries);
            var pascalCase = string.Concat(words.Select(w =>
                char.ToUpperInvariant(w[0]) + (w.Length > 1 ? w.Substring(1) : "")));
            return $"ID_CharacterTitle_{pascalCase}";
        }

        /// <summary>
        /// Checks if a title exists by its string value.
        /// </summary>
        /// <param name="titleString">The title string to check</param>
        /// <returns>True if it exists, false if not, or an error message</returns>
        public Result<bool, string> TitleExists(string titleString) {
            try {
                var filesResult = GetTitleFiles();
                if (!filesResult.Success)
                    return Result<bool, string>.FromError(filesResult.Error ?? "Failed to get title files");

                var (_, stringTable) = filesResult.Value;
                var targetHash = FindTitleHash(stringTable, titleString);

                return targetHash.HasValue;
            }
            catch (Exception ex) {
                return Result<bool, string>.FromError(ex.Message);
            }
        }

        /// <summary>
        /// Checks if a title exists by its enum ID.
        /// </summary>
        /// <param name="titleId">The enum ID of the title to check</param>
        /// <returns>True if it exists, false if not, or an error message</returns>
        public Result<bool, string> TitleExists(int titleId) {
            try {
                var filesResult = GetTitleFiles();
                if (!filesResult.Success)
                    return Result<bool, string>.FromError(filesResult.Error ?? "Failed to get title files");

                var (enumMapper, _) = filesResult.Value;
                return enumMapper.IdToStringMap.ContainsKey((uint)titleId);
            }
            catch (Exception ex) {
                return Result<bool, string>.FromError(ex.Message);
            }
        }

        /// <summary>
        /// Gets the title string for a specific enum ID.
        /// </summary>
        /// <param name="titleId">The enum ID of the title</param>
        /// <returns>The title string, or an error message</returns>
        public Result<string, string> GetTitle(int titleId) {
            try {
                var filesResult = GetTitleFiles();
                if (!filesResult.Success)
                    return Result<string, string>.FromError(filesResult.Error ?? "Failed to get title files");

                var (enumMapper, stringTable) = filesResult.Value;

                if (!enumMapper.IdToStringMap.TryGetValue((uint)titleId, out var enumId))
                    return Result<string, string>.FromError("Title ID does not exist.");

                var enumHash = enumId.ToString().ComputeHash();

                if (!stringTable.Strings.TryGetValue(enumHash, out var stringData) || stringData.Strings.Count == 0)
                    return Result<string, string>.FromError("Corresponding string table entry not found.");

                return Result<string, string>.FromSuccess(stringData.Strings[0].ToString());
            }
            catch (Exception ex) {
                return Result<string, string>.FromError(ex.Message);
            }
        }

        /// <summary>
        /// Gets the enum ID for a specific title string.
        /// </summary>
        /// <param name="titleName">The title string to find</param>
        /// <returns>The enum ID of the title, or an error message</returns>
        public Result<int, string> GetTitle(string titleName) {
            try {
                var filesResult = GetTitleFiles();
                if (!filesResult.Success)
                    return Result<int, string>.FromError(filesResult.Error ?? "Failed to get title files");

                var (enumMapper, stringTable) = filesResult.Value;
                var targetId = FindTitleId(enumMapper, stringTable, titleName);

                if (!targetId.HasValue)
                    return Result<int, string>.FromError("Title not found.");

                return (int)targetId.Value;
            }
            catch (Exception ex) {
                return Result<int, string>.FromError(ex.Message);
            }
        }

        /// <summary>
        /// Adds a new title to the DAT files. The enum ID is auto-generated based on the title string.
        /// </summary>
        /// <param name="titleString">The title string (e.g. "My New Title")</param>
        /// <returns>The ID of the newly added title, or an error message</returns>
        public Result<int, string> AddTitle(string titleString) {
            var enumId = GenerateEnumId(titleString);
            return AddTitle(titleString, enumId);
        }

        /// <summary>
        /// Adds a new title to the DAT files with a custom enum ID.
        /// </summary>
        /// <param name="titleString">The title string (e.g. "My New Title")</param>
        /// <param name="enumId">The enum ID for the new title (e.g. "ID_CharacterTitle_MyNewTitle")</param>
        /// <returns>The ID of the newly added title, or an error message</returns>
        public Result<int, string> AddTitle(string titleString, string enumId) {
            try {
                // Get the EnumMapper and StringTable files
                var filesResult = GetTitleFiles();
                if (!filesResult.Success)
                    return Result<int, string>.FromError(filesResult.Error ?? "Failed to get title files");

                var (enumMapper, stringTable) = filesResult.Value;

                // Check if the enum already exists
                if (enumMapper.IdToStringMap.ContainsValue(enumId)) {
                    return Result<int, string>.FromError("Enum ID already exists.");
                }

                // Add a new enum mapping at the next available ID
                var newEnumId = enumMapper.IdToStringMap.Count > 0 ? enumMapper.IdToStringMap.Keys.Max() + 1 : 1;
                enumMapper.IdToStringMap[newEnumId] = enumId;

                // Compute the hash based on the enum string
                var newEnumHash = enumId.ComputeHash();

                // Create and add the string table entry
                var stringTableData = new StringTableString();
                stringTableData.Strings.Add(titleString);
                stringTable.Strings[newEnumHash] = stringTableData;

                // Save the changes
                var saveResult = SaveTitleFiles(enumMapper, stringTable);
                if (!saveResult.Success)
                    return Result<int, string>.FromError(saveResult.Error ?? "Failed to save title files");

                return (int)newEnumId;
            }
            catch (Exception ex) {
                return Result<int, string>.FromError(ex.Message);
            }
        }

        /// <summary>
        /// Updates an existing title by its enum ID.
        /// </summary>
        /// <param name="titleId">The enum ID of the title to update</param>
        /// <param name="newTitle">The new title string</param>
        /// <returns>True if successful, or an error message</returns>
        public Result<bool, string> UpdateTitle(int titleId, string newTitle) {
            try {
                // Get the EnumMapper and StringTable files
                var filesResult = GetTitleFiles();
                if (!filesResult.Success)
                    return Result<bool, string>.FromError(filesResult.Error ?? "Failed to get title files");

                var (enumMapper, stringTable) = filesResult.Value;

                // Check if the title ID exists in the enum mapper
                if (!enumMapper.IdToStringMap.ContainsKey((uint)titleId))
                    return Result<bool, string>.FromError("Title ID does not exist.");

                // Get the enum string for this ID and compute the hash
                var enumId = enumMapper.IdToStringMap[(uint)titleId];
                // Since enumId is a PStringBase<byte>, we need to convert it to string for hashing
                var enumIdString = enumId.ToString();
                var enumHash = enumIdString.ComputeHash();

                // Update the corresponding entry in the string table
                if (!stringTable.Strings.ContainsKey(enumHash))
                    return Result<bool, string>.FromError("Corresponding string table entry not found.");

                // Clear the old strings and add the new title
                stringTable.Strings[enumHash].Strings.Clear();
                stringTable.Strings[enumHash].Strings.Add(newTitle);

                // Save the changes
                return SaveTitleFiles(enumMapper, stringTable);
            }
            catch (Exception ex) {
                return Result<bool, string>.FromError(ex.Message);
            }
        }

        /// <summary>
        /// Updates an existing title by its current string value.
        /// </summary>
        /// <param name="existingTitle">The current title string to find and update</param>
        /// <param name="newTitle">The new title string</param>
        /// <returns>True if successful, or an error message</returns>
        public Result<bool, string> UpdateTitle(string existingTitle, string newTitle) {
            try {
                // Get the EnumMapper and StringTable files
                var filesResult = GetTitleFiles();
                if (!filesResult.Success)
                    return Result<bool, string>.FromError(filesResult.Error ?? "Failed to get title files");

                var (enumMapper, stringTable) = filesResult.Value;

                // Find the enum hash that corresponds to the existing title
                var targetHash = FindTitleHash(stringTable, existingTitle);

                if (!targetHash.HasValue)
                    return Result<bool, string>.FromError("Existing title not found.");

                // Update the string table entry - clear old strings and add new title
                stringTable.Strings[targetHash.Value].Strings.Clear();
                stringTable.Strings[targetHash.Value].Strings.Add(newTitle);

                // Save the changes
                return SaveTitleFiles(enumMapper, stringTable);
            }
            catch (Exception ex) {
                return Result<bool, string>.FromError(ex.Message);
            }
        }

        /// <summary>
        /// Removes a title by its enum ID.
        /// </summary>
        /// <param name="existingTitleId">The enum ID of the title to remove</param>
        /// <returns>True if successful, or an error message</returns>
        public Result<bool, string> RemoveTitle(int existingTitleId) {
            try {
                // Get the EnumMapper and StringTable files
                var filesResult = GetTitleFiles();
                if (!filesResult.Success)
                    return Result<bool, string>.FromError(filesResult.Error ?? "Failed to get title files");

                var (enumMapper, stringTable) = filesResult.Value;

                // Check if the title ID exists in the enum mapper
                if (!enumMapper.IdToStringMap.ContainsKey((uint)existingTitleId))
                    return Result<bool, string>.FromError("Title ID does not exist.");

                // Get the enum string for this ID and compute its hash
                var enumId = enumMapper.IdToStringMap[(uint)existingTitleId];
                var enumIdString = enumId.ToString();
                var enumHash = enumIdString.ComputeHash();

                // Remove the entry from both the enum mapper and string table
                enumMapper.IdToStringMap.Remove((uint)existingTitleId);
                stringTable.Strings.Remove(enumHash);

                // Save the changes
                return SaveTitleFiles(enumMapper, stringTable);
            }
            catch (Exception ex) {
                return Result<bool, string>.FromError(ex.Message);
            }
        }

        /// <summary>
        /// Removes a title by its string value.
        /// </summary>
        /// <param name="existingTitle">The title string to remove</param>
        /// <returns>True if successful, or an error message</returns>
        public Result<bool, string> RemoveTitle(string existingTitle) {
            try {
                // Get the EnumMapper and StringTable files
                var filesResult = GetTitleFiles();
                if (!filesResult.Success)
                    return Result<bool, string>.FromError(filesResult.Error ?? "Failed to get title files");

                var (enumMapper, stringTable) = filesResult.Value;

                // Find the corresponding enum ID in the enum mapper
                var targetEnumId = FindTitleId(enumMapper, stringTable, existingTitle);

                if (!targetEnumId.HasValue)
                    return Result<bool, string>.FromError("Existing title not found.");

                var enumId = enumMapper.IdToStringMap[targetEnumId.Value];
                var enumHash = enumId.ToString().ComputeHash();

                // Remove the entries from both the enum mapper and string table
                enumMapper.IdToStringMap.Remove(targetEnumId.Value);
                stringTable.Strings.Remove(enumHash);

                // Save the changes
                return SaveTitleFiles(enumMapper, stringTable);
            }
            catch (Exception ex) {
                return Result<bool, string>.FromError(ex.Message);
            }
        }

        /// <summary>
        /// Helper to get both the EnumMapper and StringTable.
        /// </summary>
        private Result<(EnumMapper, StringTable), string> GetTitleFiles() {
            var enumMapperResult = GetEnumMapper(EnumMapperType.CharacterTitle);
            var stringTableResult = GetStringTable(StringTableType.CharacterTitle);

            if (!enumMapperResult)
                return Result<(EnumMapper, StringTable), string>.FromError(enumMapperResult.Error ??
                                                                           "Failed to get EnumMapper");

            if (!stringTableResult)
                return Result<(EnumMapper, StringTable), string>.FromError(stringTableResult.Error ??
                                                                           "Failed to get StringTable");

            return Result<(EnumMapper, StringTable), string>.FromSuccess((enumMapperResult.Value!,
                stringTableResult.Value!));
        }

        /// <summary>
        /// Helper to save both the EnumMapper and StringTable.
        /// </summary>
        private Result<bool, string> SaveTitleFiles(EnumMapper enumMapper, StringTable stringTable) {
            var enumSaveResult = Save(enumMapper);
            var stringTableSaveResult = Save(stringTable);

            if (!enumSaveResult.Value)
                return Result<bool, string>.FromError(enumSaveResult.Error ?? "Failed to save EnumMapper");

            if (!stringTableSaveResult.Value)
                return Result<bool, string>.FromError(stringTableSaveResult.Error ?? "Failed to save StringTable");

            return Result<bool, string>.FromSuccess(true);
        }

        /// <summary>
        /// Helper to find the hash in the string table for a specific title string.
        /// </summary>
        private uint? FindTitleHash(StringTable stringTable, string title) {
            foreach (var kvp in stringTable.Strings) {
                if (kvp.Value.Strings.Contains(title)) {
                    return kvp.Key;
                }
            }

            return null;
        }

        /// <summary>
        /// Helper to find the enum ID for a specific title string.
        /// </summary>
        private uint? FindTitleId(EnumMapper enumMapper, StringTable stringTable, string titleName) {
            var targetHash = FindTitleHash(stringTable, titleName);
            if (!targetHash.HasValue)
                return null;

            foreach (var enumKvp in enumMapper.IdToStringMap) {
                var enumStr = enumKvp.Value.ToString();
                if (enumStr.ComputeHash() == targetHash.Value) {
                    return enumKvp.Key;
                }
            }

            return null;
        }
    }
}
