namespace DatReaderWriter.Extensions {
    /// <summary>
    /// DatEasyWriter Options
    /// </summary>
    public class DatEasyWriterOptions {
        /// <summary>
        /// Weather or not to increase the iterations of the databases if files were written.
        /// </summary>
        public bool IncreaseIterations { get; init; } = false;
    }
}