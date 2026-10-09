use holtburger_protocol::errors::WeenieError;

/// use-3 (2026-10-08): the retail client's own text for the use / move /
/// pickup failure codes, verbatim from
/// `ClientCommunicationSystem::HandleFailureEvent` (acclient.c:413716,
/// cases at :415837-:415890) — the function both `Handle_Item__UseDone`
/// (:401924) and `Handle_Communication__WeenieError` (:420742) call.
/// `None` for codes outside this set.
pub fn retail_failure_text(error: WeenieError) -> Option<&'static str> {
    match error {
        WeenieError::YoureTooBusy => Some("You're too busy!"),
        WeenieError::Dead => Some("You can't do that... you're dead!"),
        WeenieError::MotionFailure
        | WeenieError::ObjectGone
        | WeenieError::NoObject
        | WeenieError::CantGetThere => Some("Unable to move to object!"),
        WeenieError::YouChargedTooFar => Some("You charged too far!"),
        WeenieError::ActionCancelled => Some("Action cancelled!"),
        WeenieError::Frozen => Some("The item is under someone else's control!"),
        WeenieError::Stuck => Some("You cannot pick that up!"),
        WeenieError::YouAreTooEncumbered => Some("You are too encumbered to carry that!"),
        _ => None,
    }
}

/// pk-3 (2026-10-08 round 5): the chat text type retail's
/// `ClientCommunicationSystem::HandleFailureEvent` (acclient.c:413716)
/// prints a code at, where the PK set differs from the default: 7 (Magic)
/// for the spell / combat / portal refusals (0x4E-0x54 :416037-416062,
/// 0x45C/0x45D :415614-415627, 0x4CC :415245, 0x4F3-0x4F9, 0x502/0x503),
/// 0 for the PK status messages (0x4EC-0x4F2, 0x504, 0x507, 0x508,
/// 0x55F, 0x560; :414486-414624). `None` = not part of that set.
pub fn retail_text_type(error: WeenieError) -> Option<u32> {
    let code = error as u32;
    match code {
        0x4E..=0x54 | 0x45C | 0x45D | 0x4CC | 0x4F3..=0x4F9 | 0x502 | 0x503 => Some(7),
        0x4EC..=0x4F2 | 0x504 | 0x507 | 0x508 | 0x55F | 0x560 => Some(0),
        _ => None,
    }
}

/// use-3 (2026-10-08): failure codes retail never prints
/// (`HandleFailureEvent` has no case for 0x3B / 0x3C, so they fall to its
/// silent default branch).
pub fn is_silent_failure(error: WeenieError) -> bool {
    matches!(error, WeenieError::ILeftTheWorld | WeenieError::ITeleported)
}

pub fn format_weenie_error(error: WeenieError, parameter: Option<&str>) -> String {
    // use-3: the retail HandleFailureEvent strings win (none of them take
    // a parameter).
    if let Some(text) = retail_failure_text(error) {
        return text.to_string();
    }
    // Some errors have custom formatting templates.
    let template = match error {
        // WeenieError (Parameter-less)
        // (YoureTooBusy → `retail_failure_text` above.)
        WeenieError::YouCantJumpWhileInTheAir => Some("You can't jump while in the air!"),
        WeenieError::YouAreTooTiredToDoThat => Some("You are too tired to do that!"),
        WeenieError::YouCantJumpFromThisPosition => Some("You can't jump from this position"),
        WeenieError::YouKilledYourself => Some("Ack! You killed yourself!"),
        WeenieError::YourFellowshipIsFull => Some("Your Fellowship is full"),
        WeenieError::LockAlreadyUnlocked => Some("The lock is already unlocked."),
        WeenieError::LockedFellowshipCannotRecruitYou => {
            Some("The fellowship is locked, you were not added to the fellowship.")
        }
        WeenieError::FellowshipIsLocked => {
            Some("The fellowship is locked; you cannot open locked fellowships.")
        }

        // WeenieErrorWithString (Parameterized)
        WeenieError::IsTooBusyToAcceptGifts => Some("{} is too busy to accept gifts right now."),
        WeenieError::CannotCarryAnymore => Some("{} cannot carry anymore."),
        WeenieError::YouFailToAffectYouCannotAffectAnyone => {
            Some("You fail to affect {} because you cannot affect anyone!")
        }
        WeenieError::YouFailToAffectTheyCannotBeHarmed => {
            Some("You fail to affect {} because they cannot be harmed!")
        }
        // pk-3: retail names the target twice (sprintf with user_data
        // twice, HandleFailureEvent :416037-416062).
        WeenieError::YouFailToAffectWithBeneficialSpells => {
            Some("You fail to affect {} because beneficial spells do not affect {}!")
        }
        WeenieError::YouFailToAffectYouAreNotPk => {
            Some("You fail to affect {} because you are not a player killer!")
        }
        WeenieError::YouFailToAffectTheyAreNotPk => {
            Some("You fail to affect {} because {} is not a player killer!")
        }
        WeenieError::YouFailToAffectNotSamePkType => Some(
            "You fail to affect {} because you are not the same sort of player killer as {}!",
        ),
        WeenieError::YouFailToAffectAcrossHouseBoundary => {
            Some("You fail to affect {} because you are acting across a house boundary!")
        }
        WeenieError::IsNotAcceptingGiftsRightNow => Some("{} is not accepting gifts right now."),
        WeenieError::IsAlreadyOneOfYourFollowers => Some("{} is already one of your followers"),
        WeenieError::CannotHaveAnyMoreVassals => Some("{} cannot have any more Vassals"),
        WeenieError::TradeAiDoesntWant => Some("{} doesn't know what to do with that."),
        WeenieError::YouMustBeAboveLevelToBuyHouse => {
            Some("You must be above level {} to purchase this dwelling.")
        }
        WeenieError::YouMustBeAtOrBelowLevelToBuyHouse => {
            Some("You must be at or below level {} to purchase this dwelling.")
        }
        WeenieError::YouMustBeAboveAllegianceRankToBuyHouse => {
            Some("You must be above allegiance rank {} to purchase this dwelling.")
        }
        WeenieError::YouMustBeAtOrBelowAllegianceRankToBuyHouse => {
            Some("You must be at or below allegiance rank {} to purchase this dwelling.")
        }
        WeenieError::TheWasNotSuitableForSalvaging => {
            Some("The {} was not suitable for salvaging.")
        }
        WeenieError::TheContainsTheWrongMaterial => Some("The {} contains the wrong material."),
        WeenieError::YouMustBeToUseItemMagic => Some("You must be {} to use that item's magic."),
        WeenieError::YourIsTooLowToUseItemMagic => {
            Some("Your {} is too low to use that item's magic.")
        }
        WeenieError::OnlyMayUseItemMagic => Some("Only {} may use that item's magic."),
        WeenieError::YouMustSpecializeToUseItemMagic => {
            Some("You must have {} specialized to use that item's magic.")
        }
        WeenieError::CannotAcceptStackedItems => {
            Some("{} cannot accept stacked objects. Try giving one at a time.")
        }
        WeenieError::YourSkillMustBeTrained => Some(
            "Your {} skill must be trained, not untrained or specialized, in order to be altered in this way!",
        ),
        WeenieError::NotEnoughSkillCreditsToSpecialize => {
            Some("You do not have enough skill credits to specialize your {} skill.")
        }
        WeenieError::TooMuchXpToRecoverFromSkill => Some(
            "You have too many available experience points to be able to absorb the experience points from your {} skill. Please spend some of your experience points and try again.",
        ),
        WeenieError::YourSkillIsAlreadyUntrained => Some("Your {} skill is already untrained!"),
        WeenieError::CannotLowerSkillWhileWieldingItem => Some(
            "You are currently wielding items which require a certain level of {}. Your skill cannot be lowered while you are wielding these items. Please remove these items and try again.",
        ),
        WeenieError::YouHaveSucceededSpecializingSkill => {
            Some("You have succeeded in specializing your {} skill!")
        }
        WeenieError::YouHaveSucceededUnspecializingSkill => {
            Some("You have succeeded in lowering your {} skill from specialized to trained!")
        }
        WeenieError::YouHaveSucceededUntrainingSkill => {
            Some("You have succeeded in untraining your {} skill!")
        }
        WeenieError::CannotUntrainSkillButRecoveredXp => Some(
            "Although you cannot untrain your {} skill, you have succeeded in recovering all the experience you had invested in it.",
        ),
        WeenieError::TooManyCreditsInSpecializedSkills => Some(
            "You have too many credits invested in specialized skills already! Before you can specialize your {} skill, you will need to unspecialize some other skill.",
        ),
        WeenieError::AttributeTransferFromTooLow => Some("{}"),
        WeenieError::AttributeTransferToTooHigh => Some("{}"),
        WeenieError::ItemUnusableOnHookCannotOpen => {
            Some("The {} cannot be used while on a hook and only the owner may open the hook.")
        }
        WeenieError::ItemUnusableOnHookCanOpen => Some(
            "The {} cannot be used while on a hook, use the '@house hooks on' command to make the hook openable.",
        ),
        WeenieError::ItemOnlyUsableOnHook => Some("The {} can only be used while on a hook."),
        WeenieError::FailsToAffectYouTheyCannotAffectAnyone => {
            Some("{} fails to affect you because they cannot affect anyone!")
        }
        WeenieError::FailsToAffectYouYouCannotBeHarmed => {
            Some("{} fails to affect you because you cannot be harmed!")
        }
        WeenieError::FailsToAffectYouTheyAreNotPk => {
            Some("{} fails to affect you because {} is not a player killer!")
        }
        WeenieError::FailsToAffectYouYouAreNotPk => {
            Some("{} fails to affect you because you are not a player killer!")
        }
        WeenieError::FailsToAffectYouNotSamePkType => Some(
            "{} fails to affect you because you are not the same sort of player killer as {}!",
        ),
        WeenieError::FailsToAffectYouAcrossHouseBoundary => {
            Some("{} fails to affect you across a house boundary!")
        }
        WeenieError::IsAnInvalidTarget => Some("{} is an invalid target."),
        WeenieError::YouAreInvalidTargetForSpellOf => {
            Some("You are an invalid target for the spell of {}.")
        }
        WeenieError::IsAtFullHealth => Some("{} is already at full health!"),
        WeenieError::YouDontHaveAllTheComponents => Some("You don't have all the components."),
        WeenieError::HasNoSpellTargets => {
            Some("{} has no appropriate targets equipped for this spell.")
        }
        WeenieError::YouHaveNoTargetsForSpellOf => {
            Some("You have no appropriate targets equipped for {}'s spell.")
        }
        WeenieError::IsNowOpenFellowship => {
            Some("{} is now an open fellowship; anyone may recruit new members.")
        }
        WeenieError::IsNowClosedFellowship => Some("{} is now a closed fellowship."),
        WeenieError::IsNowLeaderOfFellowship => Some("{} is now the leader of this fellowship."),
        WeenieError::YouHavePassedFellowshipLeadershipTo => {
            Some("You have passed leadership of the fellowship to {}")
        }
        WeenieError::MaxNumberOfHooked => Some(
            "You may not hook any more {} on your house. You already have the maximum number of hooked or you are not permitted to hook any on your type of house.",
        ),
        WeenieError::MaxNumberOfHookedUntilOneIsRemoved => Some(
            "You now have the maximum number of {} hooked. You cannot hook any additional until you remove one or more from your house.",
        ),
        WeenieError::NoLongerMaxNumberOfHooked => {
            Some("You no longer have the maximum number of {} hooked. You may hook additional.")
        }
        WeenieError::IsNotCloseEnoughToYourLevel => Some("{} is not close enough to your level."),
        WeenieError::YouHaveEnteredTheChannel => Some("You have entered the {} channel."),
        WeenieError::YouHaveLeftTheChannel => Some("You have left the {} channel."),
        WeenieError::WillNotReceiveMessage => Some(
            "{} will not receive your message, please use urgent assistance to speak with an in-game representative.",
        ),
        WeenieError::MessageBlocked => Some("Message Blocked: {}"),
        WeenieError::HasBeenAddedToHearList => {
            Some("{} has been added to the list of people you can hear.")
        }
        WeenieError::HasBeenRemovedFromHearList => {
            Some("{} has been removed from the list of people you can hear.")
        }
        WeenieError::FailToRemoveFromLoudList => Some("You fail to remove {} from your loud list."),
        WeenieError::YouAreNowSnoopingOn => Some("You are now snooping on {}."),
        WeenieError::YouAreNoLongerSnoopingOn => Some("You are no longer snooping on {}."),
        WeenieError::YouFailToSnoopOn => Some("You fail to snoop on {}."),
        WeenieError::AttemptedToSnoopOnYou => Some("{} attempted to snoop on you."),
        WeenieError::IsAlreadyBeingSnoopedOn => {
            Some("{} is already being snooped on, only one person may snoop on another at a time.")
        }
        WeenieError::IsInLimbo => Some("{} is in limbo and cannot receive your message."),
        WeenieError::HasBeenBootedFromAllegianceChat => {
            Some("{} has been booted from the allegiance chat room.")
        }
        WeenieError::AccountOfIsAlreadyBannedFromAllegiance => {
            Some("The account of {} is already banned from the allegiance.")
        }
        WeenieError::AccountOfIsNotBannedFromAllegiance => {
            Some("The account of {} is not banned from the allegiance.")
        }
        WeenieError::AccountOfWasNotUnbannedFromAllegiance => {
            Some("The account of {} was not unbanned from the allegiance.")
        }
        WeenieError::AccountOfIsBannedFromAllegiance => {
            Some("The account of {} has been banned from the allegiance.")
        }
        WeenieError::AccountOfIsUnbannedFromAllegiance => {
            Some("The account of {} is no longer banned from the allegiance.")
        }
        WeenieError::ListOfBannedCharacters => Some("Banned Characters: {}"),
        WeenieError::IsBannedFromAllegiance => Some("{} is banned from the allegiance!"),
        WeenieError::IsNowAllegianceOfficer => Some("{} is now an allegiance officer."),
        WeenieError::ErrorSettingAsAllegianceOfficer => Some(
            "An unspecified error occurred while attempting to set {} as an allegiance officer.",
        ),
        WeenieError::IsNoLongerAllegianceOfficer => Some("{} is no longer an allegiance officer."),
        WeenieError::ErrorRemovingAsAllegianceOfficer => Some(
            "An unspecified error occurred while attempting to remove {} as an allegiance officer.",
        ),
        WeenieError::YouMustWaitBeforeCommunicating => {
            Some("You must wait {} before communicating again!")
        }
        WeenieError::IsAlreadyAllegianceOfficerOfThatLevel => {
            Some("{} is already an allegiance officer of that level.")
        }
        WeenieError::TheIsCurrentlyInUse => Some("The {} is currently in use."),
        WeenieError::YouAreNotListeningToChannel => {
            Some("You are not listening to the {} channel!")
        }
        WeenieError::YouSuccededAcquiringAugmentation => {
            Some("Congratulations! You have succeeded in acquiring the {} augmentation.")
        }
        WeenieError::YouSucceededRecoveringXpFromSkillAugmentationNotUntrainable => Some(
            "Although your augmentation will not allow you to untrain your {} skill, you have succeeded in recovering all the experience you had invested in it.",
        ),
        WeenieError::IsAlreadyOnYourFriendsList => Some("{} is already on your friends list!"),
        WeenieError::YouMayOnlyChangeAllegianceNameOnceEvery24Hours => Some(
            "You may only change your allegiance name once every 24 hours. You may change your allegiance name again in {}.",
        ),
        WeenieError::IsTheMonarchAndCannotBePromotedOrDemoted => {
            Some("{} is the monarch and cannot be promoted or demoted.")
        }
        WeenieError::ThatLevelOfAllegianceOfficerIsNowKnownAs => {
            Some("That level of allegiance officer is now known as: {}.")
        }
        WeenieError::YourAllegianceIsCurrently => Some("Your allegiance is currently: {}."),
        WeenieError::YourAllegianceIsNow => Some("Your allegiance is now: {}."),
        WeenieError::YouHavePreApprovedToJoinAllegiance => {
            Some("You have pre-approved {} to join your allegiance.")
        }
        WeenieError::IsAlreadyMemberOfYourAllegiance => {
            Some("{} is already a member of your allegiance!")
        }
        WeenieError::HasBeenPreApprovedToJoinYourAllegiance => {
            Some("{} has been pre-approved to join your allegiance.")
        }
        WeenieError::IsTemporarilyGaggedInAllegianceChat => Some(
            "{} is now temporarily unable to view or speak in allegiance chat. The gag will run out in 5 minutes, or {} may be explicitly ungagged before then.",
        ),
        WeenieError::YourAllegianceChatPrivilegesRestoredBy => {
            Some("Your allegiance chat privileges have been restored by {}.")
        }
        WeenieError::YouRestoreAllegianceChatPrivilegesTo => {
            Some("You have restored allegiance chat privileges to {}.")
        }
        WeenieError::CowersFromYou => Some("{} cowers from you!"),

        // pk-3 (2026-10-08 round 5): the PK status and refusal texts,
        // verbatim from HandleFailureEvent (acclient.c:414486-414624,
        // :414128-414153, :415245-415250, :415614-415627). Without them the
        // PascalCase fallback printed "You are now p k lite."
        WeenieError::PKsMayNotUsePortal => Some("Player killers may not interact with that portal!"),
        WeenieError::NonPKsMayNotUsePortal => {
            Some("Non-player killers may not interact with that portal!")
        }
        WeenieError::YouHaveBeenInPKBattleTooRecently => {
            Some("You have been involved in a player killer battle too recently to do that!")
        }
        WeenieError::CannotChangePKStatusWhileRecovering => Some(
            "You cannot modify your player killer status while you are recovering from a PK death.",
        ),
        WeenieError::AdvocatesCannotChangePKStatus => {
            Some("Advocates may not change their player killer status!")
        }
        WeenieError::LevelTooLowToChangePKStatusWithObject => {
            Some("Your level is too low to change your player killer status with this object.")
        }
        WeenieError::LevelTooHighToChangePKStatusWithObject => {
            Some("Your level is too high to change your player killer status with this object.")
        }
        WeenieError::YouFeelAHarshDissonance => Some(
            "You feel a harsh dissonance, and you sense that an act of killing you have committed recently is interfering with the conversion.",
        ),
        WeenieError::YouArePKAgain => Some(
            "Bael'Zharon's power flows through you again. You are once more a player killer.",
        ),
        WeenieError::YouAreTemporarilyNoLongerPK => Some(
            "Bael'Zharon has granted you respite after your moment of weakness. You are temporarily no longer a player killer.",
        ),
        WeenieError::PKLiteMayNotUsePortal => {
            Some("Lite Player Killers may not interact with that portal!")
        }
        WeenieError::LifestoneMagicProtectsYou => {
            Some("The Lifestone's magic protects you from the attack!")
        }
        WeenieError::PortalEnergyProtectsYou => {
            Some("The portal's residual energy protects you from the attack!")
        }
        WeenieError::YouAreNonPKAgain => Some(
            "You are enveloped in a feeling of warmth as you are brought back into the protection of the Light. You are once again a Non-Player Killer.",
        ),
        WeenieError::OnlyNonPKsMayEnterPKLite => Some(
            "Only Non-Player Killers may enter PK Lite. Please see @help pklite for more details about this command.",
        ),
        WeenieError::YouAreNowPKLite => {
            Some("A cold wind touches your heart. You are now a Player Killer Lite.")
        }
        WeenieError::OnlyPKsMayUseCommand => {
            Some("Only Player Killer characters may use this command!")
        }
        WeenieError::OnlyPKLiteMayUseCommand => {
            Some("Only Player Killer Lite characters may use this command!")
        }
        _ => None,
    };

    // If we have a custom template, use it.
    if let Some(t) = template {
        let p = parameter.unwrap_or("Unknown");
        return t.replace("{}", p);
    }

    // Fallback: Convert the enum name "PascalCase" to "Sentence case"
    let variant_name = error.to_string();
    let mut sentence = String::new();
    for (i, c) in variant_name.chars().enumerate() {
        if i > 0 && c.is_uppercase() {
            sentence.push(' ');
            sentence.push(c.to_ascii_lowercase());
        } else {
            sentence.push(c);
        }
    }

    // Final polish for sentence ending
    if !sentence.ends_with('.') && !sentence.ends_with('!') && !sentence.ends_with('?') {
        sentence.push('.');
    }

    if let Some(p) = parameter {
        format!("{}: {}", sentence, p)
    } else {
        sentence
    }
}

pub fn format_weenie_error_id(error_id: u32, parameter: Option<&str>) -> String {
    if let Some(error) = WeenieError::from_repr(error_id) {
        format_weenie_error(error, parameter)
    } else {
        format!(
            "Unknown error {:#06X}{}",
            error_id,
            parameter.map(|p| format!(" ({})", p)).unwrap_or_default()
        )
    }
}

pub fn is_actually_weenie_error(err: WeenieError) -> bool {
    !matches!(
        err,
        WeenieError::YouHaveSucceededSpecializingSkill
            | WeenieError::YouHaveSucceededTransferringAttributes
            | WeenieError::YouHaveSucceededUntrainingSkill
            | WeenieError::TurbineChatIsEnabled
            | WeenieError::YouHaveLeftTheChannel
            | WeenieError::ITeleported
            | WeenieError::YouHaveEnteredTheChannel
            | WeenieError::CharacterNotAvailable
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn use_failures_read_as_retail() {
        assert_eq!(format_weenie_error(WeenieError::YoureTooBusy, None), "You're too busy!");
        assert_eq!(format_weenie_error(WeenieError::ActionCancelled, None), "Action cancelled!");
        assert_eq!(
            format_weenie_error(WeenieError::NoObject, None),
            "Unable to move to object!"
        );
        assert_eq!(
            format_weenie_error(WeenieError::CantGetThere, None),
            "Unable to move to object!"
        );
        assert_eq!(
            format_weenie_error(WeenieError::MotionFailure, None),
            "Unable to move to object!"
        );
        assert_eq!(
            format_weenie_error(WeenieError::ObjectGone, None),
            "Unable to move to object!"
        );
        assert_eq!(format_weenie_error(WeenieError::Stuck, None), "You cannot pick that up!");
        assert_eq!(
            format_weenie_error(WeenieError::YouChargedTooFar, None),
            "You charged too far!"
        );
        assert_eq!(
            format_weenie_error(WeenieError::Frozen, None),
            "The item is under someone else's control!"
        );
        assert_eq!(
            format_weenie_error(WeenieError::YouAreTooEncumbered, None),
            "You are too encumbered to carry that!"
        );
        assert_eq!(
            format_weenie_error(WeenieError::Dead, None),
            "You can't do that... you're dead!"
        );
    }

    #[test]
    fn retail_text_only_for_the_failure_set() {
        assert_eq!(retail_failure_text(WeenieError::Stuck), Some("You cannot pick that up!"));
        assert_eq!(retail_failure_text(WeenieError::YouKilledYourself), None);
        // Other templates still apply.
        assert_eq!(
            format_weenie_error(WeenieError::YouKilledYourself, None),
            "Ack! You killed yourself!"
        );
    }

    #[test]
    fn pk_texts_read_as_retail() {
        use WeenieError as E;
        for (error, text) in [
            (E::YouAreNowPKLite, "A cold wind touches your heart. You are now a Player Killer Lite."),
            (
                E::YouAreTemporarilyNoLongerPK,
                "Bael'Zharon has granted you respite after your moment of weakness. You are temporarily no longer a player killer.",
            ),
            (
                E::YouArePKAgain,
                "Bael'Zharon's power flows through you again. You are once more a player killer.",
            ),
            (
                E::YouAreNonPKAgain,
                "You are enveloped in a feeling of warmth as you are brought back into the protection of the Light. You are once again a Non-Player Killer.",
            ),
            (
                E::OnlyNonPKsMayEnterPKLite,
                "Only Non-Player Killers may enter PK Lite. Please see @help pklite for more details about this command.",
            ),
            (
                E::YouHaveBeenInPKBattleTooRecently,
                "You have been involved in a player killer battle too recently to do that!",
            ),
            (E::PKsMayNotUsePortal, "Player killers may not interact with that portal!"),
            (E::PKLiteMayNotUsePortal, "Lite Player Killers may not interact with that portal!"),
            (E::OnlyPKsMayUseCommand, "Only Player Killer characters may use this command!"),
            (E::OnlyPKLiteMayUseCommand, "Only Player Killer Lite characters may use this command!"),
        ] {
            assert_eq!(format_weenie_error(error, None), text, "{error:?}");
        }
        // The named forms carry the name twice, as retail's sprintf does.
        assert_eq!(
            format_weenie_error(E::YouFailToAffectTheyAreNotPk, Some("Bob")),
            "You fail to affect Bob because Bob is not a player killer!"
        );
        assert_eq!(
            format_weenie_error(E::FailsToAffectYouNotSamePkType, Some("Bob")),
            "Bob fails to affect you because you are not the same sort of player killer as Bob!"
        );
        assert_eq!(
            format_weenie_error(E::YouFailToAffectYouAreNotPk, Some("Bob")),
            "You fail to affect Bob because you are not a player killer!"
        );
    }

    #[test]
    fn pk_text_types_follow_handle_failure_event() {
        assert_eq!(retail_text_type(WeenieError::PKLiteMayNotUsePortal), Some(7));
        assert_eq!(retail_text_type(WeenieError::YouHaveBeenInPKBattleTooRecently), Some(7));
        assert_eq!(retail_text_type(WeenieError::YouFailToAffectTheyAreNotPk), Some(7));
        assert_eq!(retail_text_type(WeenieError::LifestoneMagicProtectsYou), Some(7));
        assert_eq!(retail_text_type(WeenieError::YouAreNowPKLite), Some(0));
        assert_eq!(retail_text_type(WeenieError::OnlyPKsMayUseCommand), Some(0));
        assert_eq!(retail_text_type(WeenieError::YoureTooBusy), None);
    }

    #[test]
    fn silent_failures() {
        assert!(is_silent_failure(WeenieError::ITeleported));
        assert!(is_silent_failure(WeenieError::ILeftTheWorld));
        assert!(!is_silent_failure(WeenieError::Stuck));
        assert!(!is_silent_failure(WeenieError::YoureTooBusy));
    }
}
