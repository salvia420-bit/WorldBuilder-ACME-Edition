using Avalonia.Controls;
using Avalonia.Input;
using Avalonia.Interactivity;
using WorldBuilder.ViewModels;

namespace WorldBuilder.Views;

/// <summary>
/// Keyboard-first shell for <see cref="TexturePickerPanelViewModel"/>. Every judgement key is a
/// single press with no modifier so the human's hand never leaves the home row while A/B-ing.
///
///   ↑ / K            previous worklist row
///   ↓ / J            next worklist row
///   N                jump to next undecided row
///   1 … 5            select that candidate into the preview
///   Space            toggle retail vs selected candidate  (the taste toggle)
///   Enter            pick the selected candidate for this row
///   S                skip this row
///   C                clear this row's decision
///   [ / ]            repeat factor X down / up
///   , / .            repeat factor Y down / up
///   - / =            repeat factor both axes down / up
///   R                reset repeat to the candidate's suggestion
///
/// Handled at the tunnelling stage so the embedded worklist ListBox cannot swallow the arrow keys.
/// </summary>
public partial class TexturePickerPanelView : UserControl {
    public TexturePickerPanelView() {
        InitializeComponent();
        AddHandler(KeyDownEvent, OnPanelKeyDown, RoutingStrategies.Tunnel);
    }

    private void OnPanelKeyDown(object? sender, KeyEventArgs e) {
        if (DataContext is not TexturePickerPanelViewModel vm) return;

        // Never steal keys from a text entry field.
        if (e.Source is TextBox) return;

        switch (e.Key) {
            case Key.Up:
            case Key.K:
                vm.PrevRowCommand.Execute(null);
                break;
            case Key.Down:
            case Key.J:
                vm.NextRowCommand.Execute(null);
                break;
            case Key.N:
                vm.NextUndecidedRowCommand.Execute(null);
                break;
            case Key.D1:
            case Key.NumPad1:
                vm.SelectCandidateByHotkey(1);
                break;
            case Key.D2:
            case Key.NumPad2:
                vm.SelectCandidateByHotkey(2);
                break;
            case Key.D3:
            case Key.NumPad3:
                vm.SelectCandidateByHotkey(3);
                break;
            case Key.D4:
            case Key.NumPad4:
                vm.SelectCandidateByHotkey(4);
                break;
            case Key.D5:
            case Key.NumPad5:
                vm.SelectCandidateByHotkey(5);
                break;
            case Key.Space:
                vm.ToggleRetailCommand.Execute(null);
                break;
            case Key.Enter:
                vm.PickCurrentCommand.Execute(null);
                break;
            case Key.S:
                vm.SkipCurrentCommand.Execute(null);
                break;
            case Key.C:
                vm.ClearCurrentDecisionCommand.Execute(null);
                break;
            case Key.OemOpenBrackets:
                vm.StepRepeatXCommand.Execute("-0.25");
                break;
            case Key.OemCloseBrackets:
                vm.StepRepeatXCommand.Execute("0.25");
                break;
            case Key.OemComma:
                vm.StepRepeatYCommand.Execute("-0.25");
                break;
            case Key.OemPeriod:
                vm.StepRepeatYCommand.Execute("0.25");
                break;
            case Key.OemMinus:
            case Key.Subtract:
                vm.StepRepeatBothCommand.Execute("-0.25");
                break;
            case Key.OemPlus:
            case Key.Add:
                vm.StepRepeatBothCommand.Execute("0.25");
                break;
            case Key.R:
                vm.ResetRepeatCommand.Execute(null);
                break;
            default:
                return;
        }

        e.Handled = true;
    }
}
