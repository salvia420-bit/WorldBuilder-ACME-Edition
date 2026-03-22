# DatReaderWriter.Extensions

Extensions for DatReaderWriter that provide high-level helpers for working with Asheron's Call dat files.

## Table of Contents

- [Installation](#installation)
- [DatEasyWriter](#dateasywriter)
  - [Initializing DatEasyWriter](#initializing-dateasywriter)
  - [Managing Titles](#managing-titles)
  - [RenderSurface Management](#rendersurface-management)
  - [Generic Database Operations](#generic-database-operations)
  - [Accessing Mappers and String Tables](#accessing-mappers-and-string-tables)
- [DatDatabase Extensions](#datdatabase-extensions)
  - [Defragment](#defragment)
  - [Compress](#compress)
  - [Cloning and Header Operations](#cloning-and-header-operations)
- [DBObj Extensions](#dbobj-extensions)
  - [RenderSurface Extensions](#rendersurface-extensions)
  - [Other Extensions](#other-extensions)
- [Contributing](#contributing)
- [License](#license)

## Installation

Install the `Chorizite.DatReaderWriter.Extensions` package from NuGet:

```bash
dotnet add package Chorizite.DatReaderWriter.Extensions
```

## DatEasyWriter

`DatEasyWriter` provides a high-level API for reading and writing to dat files.

### Initializing DatEasyWriter

You can initialize `DatEasyWriter` pointing to a directory containing your portal/cell/local.dat files, or use an existing `DatCollection`.

```csharp
using DatReaderWriter.Extensions;
using DatReaderWriter.Options;

// From directory
using var writer = new DatEasyWriter("C:\\Turbine\\Asheron's Call");

// With options (e.g. auto-increment iterations)
var options = new DatEasyWriterOptions { IncreaseIterations = true };
using var writerWithOptions = new DatEasyWriter("C:\\Turbine\\Asheron's Call", options);
```

### Managing Titles

`DatEasyWriter` provides high-level helpers for managing character titles (adding, updating, removing, getting, checking existence). These methods handle the underlying `EnumMapper` and `StringTable` updates for you.

```csharp
// Add a new title (Enum ID is auto-generated)
var newTitleIdResult = writer.AddTitle("My Legendary Title");
if (newTitleIdResult.Success) {
    Console.WriteLine($"Added title with ID: {newTitleIdResult.Value}");
}

// Add a title with a specific Enum ID
writer.AddTitle("Another Title", "ID_CharacterTitle_AnotherTitle");

// Update a title by ID
writer.UpdateTitle(newTitleIdResult.Value, "My Updated Legendary Title");

// Update a title by string match
writer.UpdateTitle("My Updated Legendary Title", "My Final Title");

// Remove a title by ID
writer.RemoveTitle(newTitleIdResult.Value);

// Remove a title by string
writer.RemoveTitle("My Final Title");

// Get a title by ID
var getTitleResult = writer.GetTitle(newTitleIdResult.Value);
if (getTitleResult.Success) {
    Console.WriteLine($"Title string: {getTitleResult.Value}");
}

// Get a title ID by string
var getTitleIdResult = writer.GetTitle("My Final Title");
if (getTitleIdResult.Success) {
    Console.WriteLine($"Title ID: {getTitleIdResult.Value}");
}

// Check if a title exists by string
bool existsByString = writer.TitleExists("My Legendary Title").Value;

// Check if a title exists by ID
bool existsById = writer.TitleExists(newTitleIdResult.Value).Value;
```

### RenderSurface Management

`DatEasyWriter` provides high-level helpers for managing RenderSurfaces (getting, adding, updating, saving).

```csharp
// Get a RenderSurface by ID
var renderSurfaceResult = writer.GetRenderSurface(0x06001234);
if (renderSurfaceResult.Success) {
    var renderSurface = renderSurfaceResult.Value;
    // Work with renderSurface...
}

// Add a new RenderSurface with an image file
var addResult = writer.AddRenderSurface(0x06005678, "path/to/new_image.png", PixelFormat.A8R8G8B8);
if (addResult.Success && addResult.Value) {
    Console.WriteLine("RenderSurface added successfully");
}

// Update an existing RenderSurface with a new image
var updateResult = writer.UpdateRenderSurface(0x06001234, "path/to/updated_image.png", shouldResize: true);
if (updateResult.Success && updateResult.Value) {
    Console.WriteLine("RenderSurface updated successfully");
}

// Save a RenderSurface to an image file
var saveResult = writer.SaveRenderSurfaceToImage(0x06001234, "path/to/output_image.png");
if (saveResult.Success && saveResult.Value) {
    Console.WriteLine("RenderSurface saved to image successfully");
}
```

### Generic Database Operations

You can easily get and save `DBObj` files using the generic helpers.

```csharp
// Get a file (e.g. a LandBlock 0xFFFF0000)
var result = writer.Get<LandBlock>(0xFFFF0000);
if (result.Success) {
    var landBlock = result.Value;
    // Modify landBlock...
    
    // Save it back. If IncreaseIterations is true, the iteration count will update.
    writer.Save(landBlock);
}
```

### Accessing Mappers and String Tables

- **`DatEasyWriter.GetEnumMapper(EnumMapperType)`**: Helper to fetch a specific EnumMapper.
- **`DatEasyWriter.GetStringTable(StringTableType)`**: Helper to fetch a specific StringTable.

## DatDatabase Extensions

Extension methods for `DatDatabase` that provide database-level operations.

### Defragment

Defragments a dat database by rewriting it to a new file with sequential blocks. This removes any wasted space from deleted or fragmented files.

```csharp
using DatReaderWriter;
using DatReaderWriter.Extensions;

using var db = new DatDatabase(opt => {
    opt.FilePath = "portal.dat";
    opt.AccessType = DatAccessType.Read;
});

// Defragment to a new file
int bytesFreed = db.Defragment("portal_defragmented.dat");
Console.WriteLine($"Freed {bytesFreed} bytes");

// With progress callback
db.Defragment("portal_defragmented.dat", progress => {
    Console.WriteLine($"Progress: {progress * 100:F1}%");
});
```

### Compress

Compresses all files in the dat database and writes them to a new file. This is similar to defragmentation but also applies ZLib compression to files.
**Note:** The client must be patched to support reading these compressed files.

```csharp
// Compress to a new file
int bytesFreed = db.Compress("portal_compressed.dat");
Console.WriteLine($"Freed {bytesFreed} bytes");

// With progress callback
db.Compress("portal_compressed.dat", progress => {
    Console.WriteLine($"Progress: {progress * 100:F1}%");
});
```

### Cloning and Header Operations

Helper methods for creating new dat files or copying headers.

```csharp
// Create a new empty dat file with the same settings (block size, type, version) as the source
using var newDb = db.CloneEmpty("new_file.dat");

// Copy the header information (Version, LRU settings, MasterMapId) from one DB to another
newDb.CopyHeaderFrom(db);
```

## DBObj Extensions

Extension methods for working with individual `DBObj` instances.

### RenderSurface Extensions

Extensions for `RenderSurface` (textures) to easily replace or export image data.

```csharp
using DatReaderWriter.Extensions.DBObjs;

// Replace a texture with a PNG/BMP/etc on disk
var renderSurface = writer.Get<RenderSurface>(0x06001234).Value;

// Replace and optionally resize to match original dimensions
renderSurface.ReplaceWith("path/to/new_texture.png", shouldResize: true);
writer.Save(renderSurface);

// Export a texture to a file
renderSurface.SaveToImageFile("path/to/extracted_texture.png", writer);

// Get raw RGBA bytes
byte[] rgbaBytes = renderSurface.ToRgba8(writer);
```

### Other Extensions

- **`DBObj.GetDatFileType()`**: Returns the `DatFileType` (Portal, Cell, Local) a generic `DBObj` belongs to.
- **`string.ComputeHash()`**: Computes the Asheron's Call specific hash of a string (useful for StringTables).


## Contributing

We welcome contributions from the community! If you would like to contribute to DatReaderWriter, please follow these steps:

1. Fork the repository.
2. Create a new branch (`git checkout -b feature-branch`).
3. Make your changes.
4. Commit your changes (`git commit -am 'Add some feature'`).
5. Push to the branch (`git push origin feature-branch`).
6. Create a new Pull Request.

## License

This project is licensed under the MIT License. See the LICENSE.txt file for details.
