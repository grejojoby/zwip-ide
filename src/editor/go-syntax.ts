import { LanguageSupport } from '@codemirror/language';
import { goLanguage } from '@codemirror/lang-go';
import { styleTags, tags } from '@lezer/highlight';

/** Go grammar with GoLand-style roles for methods, method calls and constants. */
export function goSyntax(): LanguageSupport {
  return new LanguageSupport(
    goLanguage.configure({
      props: [
        styleTags({
          'MethodDecl/FieldName MethodElem/FieldName': tags.function(
            tags.definition(tags.propertyName),
          ),
          'CallExpr/SelectorExpr/FieldName': tags.function(tags.propertyName),
          'ConstSpec/DefName': tags.constant(tags.variableName),
        }),
      ],
    }),
  );
}
