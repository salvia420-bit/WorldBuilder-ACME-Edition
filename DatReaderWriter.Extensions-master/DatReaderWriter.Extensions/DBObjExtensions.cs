using DatReaderWriter.Enums;
using DatReaderWriter.Types;

namespace DatReaderWriter.Extensions {
    /// <summary>
    /// DBObj extensions
    /// </summary>
    public static class DBObjExtensions {
        /// <summary>
        /// Gets the <see cref="DatFileType"/> for the specified <see cref="DBObj"/>
        /// </summary>
        /// <param name="dbObj">The DBObj to get the DatFileType of</param>
        /// <returns></returns>
        public static DatFileType GetDatFileType(this DBObj dbObj) {
            switch (dbObj.DBObjType) {
                case DBObjType.Iteration:
                case DBObjType.GfxObj:
                case DBObjType.Setup:
                case DBObjType.Animation:
                case DBObjType.Palette:
                case DBObjType.SurfaceTexture:
                case DBObjType.RenderSurface:
                case DBObjType.Surface:
                case DBObjType.MotionTable:
                case DBObjType.Wave:
                case DBObjType.Environment:
                case DBObjType.ChatPoseTable:
                case DBObjType.ObjectHierarchy:
                case DBObjType.BadDataTable:
                case DBObjType.TabooTable:
                case DBObjType.NameFilterTable:
                case DBObjType.PalSet:
                case DBObjType.ClothingTable:
                case DBObjType.GfxObjDegradeInfo:
                case DBObjType.Scene:
                case DBObjType.Region:
                case DBObjType.MasterInputMap:
                case DBObjType.RenderTexture:
                case DBObjType.RenderMaterial:
                case DBObjType.MaterialModifier:
                case DBObjType.MaterialInstance:
                case DBObjType.SoundTable:
                case DBObjType.EnumMapper:
                case DBObjType.EnumIDMap:
                case DBObjType.ActionMap:
                case DBObjType.DualEnumIDMap:
                case DBObjType.LanguageString:
                case DBObjType.ParticleEmitter:
                case DBObjType.PhysicsScript:
                case DBObjType.PhysicsScriptTable:
                case DBObjType.MasterProperty:
                case DBObjType.Font:
                case DBObjType.DBProperties:
                case DBObjType.CharGen:
                case DBObjType.VitalTable:
                case DBObjType.SkillTable:
                case DBObjType.SpellTable:
                case DBObjType.SpellComponentTable:
                case DBObjType.ExperienceTable:
                case DBObjType.QualityFilter:
                case DBObjType.CombatTable:
                case DBObjType.ContractTable:
                    break;
                case DBObjType.LandBlock:
                case DBObjType.LandBlockInfo:
                case DBObjType.EnvCell:
                    return DatFileType.Cell; 
                case DBObjType.LayoutDesc:
                case DBObjType.StringTable:
                case DBObjType.LanguageInfo:
                    return DatFileType.Local;
            }
            return DatFileType.Undefined;
        }
    }
}