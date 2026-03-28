-- Safe replace wrapper for the full-world OutdoorML planner-v2 kit.
-- Run from this directory so the SOURCE path resolves correctly:
--   cd /home/salvia420/WorldBuilder-ACME-Edition/playkits/outdoorml_planner_v2_fullworld_2026-03-28/sql
--   mysql -u root -p ace_world < fullworld_replace_safe.sql

START TRANSACTION;

DELETE lil
FROM `landblock_instance_link` lil
JOIN `landblock_instance` parent_inst
  ON parent_inst.`guid` = lil.`parent_GUID`
WHERE ((parent_inst.`obj_Cell_Id` >> 24) BETWEEN 8 AND 246)
  AND (((parent_inst.`obj_Cell_Id` >> 16) & 255) BETWEEN 8 AND 246);

DELETE lil
FROM `landblock_instance_link` lil
JOIN `landblock_instance` child_inst
  ON child_inst.`guid` = lil.`child_GUID`
WHERE ((child_inst.`obj_Cell_Id` >> 24) BETWEEN 8 AND 246)
  AND (((child_inst.`obj_Cell_Id` >> 16) & 255) BETWEEN 8 AND 246);

DELETE FROM `landblock_instance`
WHERE ((`obj_Cell_Id` >> 24) BETWEEN 8 AND 246)
  AND (((`obj_Cell_Id` >> 16) & 255) BETWEEN 8 AND 246);

DELETE FROM `encounter`
WHERE ((`landblock` >> 8) BETWEEN 8 AND 246)
  AND ((`landblock` & 255) BETWEEN 8 AND 246);

SOURCE fullworld_planner_v2_2026-03-28.sql;

COMMIT;
