import 'package:flutter_test/flutter_test.dart';
import 'package:nexusia/main.dart';

void main() {
  testWidgets('NexusIA smoke test', (WidgetTester tester) async {
    await tester.pumpWidget(const NexusIAApp());
    await tester.pump();
    expect(find.byType(NexusIAApp), findsOneWidget);
  });
}
