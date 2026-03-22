using System.Text;

namespace DatReaderWriter.Extensions
{
    /// <summary>
    /// Extension methods for string hashing functionality.
    /// </summary>
    public static class StringHashExtensions
    {
        /// <summary>
        /// Computes the hash for a string using the AC-specific algorithm.
        /// </summary>
        /// <param name="strToHash">The string to hash</param>
        /// <returns>The computed hash as a uint</returns>
        public static uint ComputeHash(this string strToHash)
        {
            long result = 0;

            if (strToHash.Length > 0)
            {
                Encoding.RegisterProvider(CodePagesEncodingProvider.Instance);
                byte[] str = Encoding.GetEncoding(1252).GetBytes(strToHash);

                foreach (sbyte c in str)
                {
                    result = c + (result << 4);

                    if ((result & 0xF0000) != 0)
                        result = (result ^ ((result & 0xF0000000) >> 24)) & 0x0FFFFFFF;
                }
            }

            return (uint)result;
        }
    }
}
