using DatReaderWriter.DBObjs;
using DatReaderWriter.Extensions.DBObjs;
using DatReaderWriter.Lib;
using DatReaderWriter.Enums;

namespace DatReaderWriter.Extensions {
    public partial class DatEasyWriter {
        /// <summary>
        /// Gets a RenderSurface by its ID.
        /// </summary>
        /// <param name="id">The ID of the RenderSurface</param>
        /// <returns>The RenderSurface, or an error message</returns>
        public Result<RenderSurface, string> GetRenderSurface(uint id) {
            return Get<RenderSurface>(id);
        }

        /// <summary>
        /// Adds a new RenderSurface to the DAT files.
        /// </summary>
        /// <param name="id">The ID for the new RenderSurface</param>
        /// <param name="imageFilePath">The absolute path to an image file (bmp/png/gif/jpg)</param>
        /// <param name="format">The target pixel format</param>
        /// <returns>True if successful, or an error message</returns>
        public Result<bool, string> AddRenderSurface(uint id, string imageFilePath, PixelFormat format) {
            try {
                var renderSurface = new RenderSurface { Id = id, Format = format };

                var replaceResult = renderSurface.ReplaceWith(imageFilePath);
                if (!replaceResult.Success)
                    return replaceResult;

                return Save(renderSurface);
            }
            catch (Exception ex) {
                return Result<bool, string>.FromError(ex.Message);
            }
        }

        /// <summary>
        /// Updates an existing RenderSurface with a new image.
        /// </summary>
        /// <param name="id">The ID of the RenderSurface to update</param>
        /// <param name="imageFilePath">The absolute path to the new image file</param>
        /// <param name="shouldResize">Whether to resize the image to the same size as the existing texture. Defaults to false</param>
        /// <returns>True if successful, or an error message</returns>
        public Result<bool, string> UpdateRenderSurface(uint id, string imageFilePath, bool shouldResize = false) {
            try {
                var getResult = GetRenderSurface(id);
                if (!getResult.Success || getResult.Value is null)
                    return Result<bool, string>.FromError(getResult.Error ?? "RenderSurface not found");

                var renderSurface = getResult.Value;
                var replaceResult = renderSurface.ReplaceWith(imageFilePath, shouldResize);
                if (!replaceResult.Success)
                    return replaceResult;

                return Save(renderSurface);
            }
            catch (Exception ex) {
                return Result<bool, string>.FromError(ex.Message);
            }
        }

        /// <summary>
        /// Saves a RenderSurface to an image file.
        /// </summary>
        /// <param name="id">The ID of the RenderSurface to save</param>
        /// <param name="outputFilePath">The path to save the image (extension determines format)</param>
        /// <returns>True if successful, or an error message</returns>
        public Result<bool, string> SaveRenderSurfaceToImage(uint id, string outputFilePath) {
            try {
                var getResult = GetRenderSurface(id);
                if (!getResult.Success || getResult.Value is null)
                    return Result<bool, string>.FromError(getResult.Error ?? "RenderSurface not found");

                return getResult.Value.SaveToImageFile(outputFilePath, this);
            }
            catch (Exception ex) {
                return Result<bool, string>.FromError(ex.Message);
            }
        }
    }
}
