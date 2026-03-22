using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Lib;
using DatReaderWriter.Options;
using DatReaderWriter.Types;

namespace DatReaderWriter.Extensions {
    /// <summary>
    /// A class with helper methods for easily updating dat files.
    /// </summary>
    public partial class DatEasyWriter : IDisposable {
        private readonly Dictionary<DatFileType, int> _currentIterations = [];
        private readonly bool _isMyDatCollection;

        /// <summary>
        /// The DatCollection being used.
        /// </summary>
        public DatCollection Dats { get; }

        /// <summary>
        /// The options for this DatEasyWriter
        /// </summary>
        public DatEasyWriterOptions Options { get; }

        /// <summary>
        /// Creates a new DatEasyWriter from a datDirectory path.
        /// </summary>
        /// <param name="datDirectory"></param>
        /// <param name="options"></param>
        public DatEasyWriter(string datDirectory, DatEasyWriterOptions? options = null) : this(new DatCollection(datDirectory, DatAccessType.ReadWrite), options) {
            _isMyDatCollection = true;
        }

        /// <summary>
        /// Create a DatEasyWriter from an existing <see cref="DatCollection"/>. The dats must be opened in
        /// <see cref="DatAccessType.ReadWrite"/> mode.
        /// </summary>
        /// <param name="datCollection"></param>
        /// <param name="options"></param>
        /// <exception cref="ArgumentException"></exception>
        public DatEasyWriter(DatCollection datCollection, DatEasyWriterOptions? options = null) {
            if (datCollection.Portal.Options.AccessType != DatAccessType.ReadWrite
                || datCollection.Cell.Options.AccessType != DatAccessType.ReadWrite
                || datCollection.Local.Options.AccessType != DatAccessType.ReadWrite) {
                throw new ArgumentException($"DatCollection must be opened with DatAccessType.ReadWrite");
            }

            Dats = datCollection;
            Options = options ?? new DatEasyWriterOptions();

            if (Options.IncreaseIterations) {
                // get current iterations
                _currentIterations[DatFileType.Cell] = Dats.Cell.Iteration.CurrentIteration;
                _currentIterations[DatFileType.Local] = Dats.Local.Iteration.CurrentIteration;
                _currentIterations[DatFileType.Portal] = datCollection.Portal.Iteration.CurrentIteration;
            }
        }

        /// <summary>
        /// Try to write a file to the dats. If <see cref="DatEasyWriterOptions.IncreaseIterations"/> is set to true,
        /// this will also increase the iteration (once per dat file).
        /// </summary>
        /// <param name="file"></param>
        /// <typeparam name="T"></typeparam>
        /// <returns></returns>
        public Result<bool, string> Save<T>(T file) where T : DBObj {
            int? iteration = Options.IncreaseIterations ? (_currentIterations[file.GetDatFileType()] + 1) : null;

            if (file.DBObjType == DBObjType.RenderSurface) {
                // first look if file is in highres
                if (Dats.HighRes.Tree.HasFile(file.Id)) {
                    if (!Dats.HighRes.TryWriteFile(file, iteration)) {
                        return Result<bool, string>.FromError($"Unable to write file {file.Id} ({file.DBObjType}) to  highres dat.");
                    }

                    return true;
                }
            }

            if (!Dats.TryWriteFile(file, iteration)) {
                return Result<bool, string>.FromError($"Unable to write file {file.Id} ({file.DBObjType}) to dats.");
            }

            return true;
        }

        /// <summary>
        /// Try to get a file from the dat collection.
        /// </summary>
        /// <param name="fileId"></param>
        /// <typeparam name="T"></typeparam>
        /// <returns></returns>
        public Result<T, string> Get<T>(uint fileId) where T : DBObj {
            if (Dats.TryGet<T>(fileId, out var result)) {
                return result;
            }

            return $"Unable to get file: 0x{fileId:X8}";
        }

        /// <summary>
        /// Dispose of this DatEasyWriter. This will dispose the <see cref="DatCollection"/> if
        /// <see cref="DatEasyWriterOptions.IncreaseIterations"/> is set to true.
        /// </summary>
        public void Dispose() {
            if (_isMyDatCollection) {
                Dats.Dispose();
            }
        }
    }
}